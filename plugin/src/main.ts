import { Notice, Plugin, debounce, requestUrl } from 'obsidian';
import {
	DEFAULT_SETTINGS,
	EXCLUDED_PATHS,
	SyncSettings,
	VaultyPluginSettingTab,
} from './settings';

export default class VaultyPlugin extends Plugin {
	settings!: SyncSettings;
	isSyncing = false;
	pendingSync = true;

	debouncedSync = debounce(
		() => {
			void this.runSync(true);
		},
		5000,
		true,
	); // Wait 5sec after typing, then run synd

	async onload() {
		await this.loadSettings();

		// Ribbon icon to trigger manual sync
		this.addRibbonIcon('refresh-cw', 'Sync with Homeserver', () => {
			void this.runSync(false);
		});

		// Command palette entry
		this.addCommand({
			id: 'trigger-homeserver-sync',
			name: 'Sync vault with homeserver',
			callback: () => void this.runSync(false),
		});

		this.addSettingTab(new VaultyPluginSettingTab(this.app, this));

		// Register vault event triggers (needs to wait for layout)
		this.app.workspace.onLayoutReady(() => {
			void this.runSync(true);

			this.registerEvent(
				this.app.vault.on('create', (file) =>
					this.onLocalChange(file.path),
				),
			);
			this.registerEvent(
				this.app.vault.on('modify', (file) =>
					this.onLocalChange(file.path),
				),
			);
			this.registerEvent(
				this.app.vault.on('delete', (file) =>
					this.onLocalChange(file.path),
				),
			);
			this.registerEvent(
				this.app.vault.on('rename', (file, oldPath) => {
					this.onLocalChange(file.path);
					this.onLocalChange(oldPath);
				}),
			);
		});

		// Register periodic background sync
		this.registerInterval(
			window.setInterval(() => {
				if (this.settings.autoSyncIntervalSeconds > 0) {
					void this.runSync(true);
				}
			}, this.settings.autoSyncIntervalSeconds * 1000),
		);
	}

	onLocalChange(path: string) {
		if (this.isExcluded(path)) return;
		if (this.isSyncing) {
			// Don't drop the change — re-run sync once the current one finishes
			this.pendingSync = true;
			return;
		}
		this.debouncedSync();
	}

	isExcluded(path: string): boolean {
		if (EXCLUDED_PATHS.has(path)) return true;
		if (!this.settings.syncSettingsFolder && path.startsWith('.obsidian/'))
			return true;
		return false;
	}

	async walkAdapterFiles(dir = ''): Promise<string[]> {
		const results: string[] = [];
		const listed = await this.app.vault.adapter.list(dir);
		for (const file of listed.files) {
			if (!this.isExcluded(file)) {
				results.push(file);
			}
		}

		for (const folder of listed.folders) {
			if (folder === '.obsidian' && !this.settings.syncSettingsFolder)
				continue;
			if (folder === '.trash') continue;
			const subFiles = await this.walkAdapterFiles(folder);
			results.push(...subFiles);
		}
		return results;
	}

	// Compute SHA-256 using Web Crypto API (works on Desktop & Mobile)
	async hashBuffer(buffer: ArrayBuffer): Promise<string> {
		const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
		return Array.from(new Uint8Array(hashBuffer))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');
	}

	// Helpers for Base64 conversion
	arrayBufferToBase64(buffer: ArrayBuffer): string {
		let binary = '';
		const bytes = new Uint8Array(buffer);
		for (const byte of bytes) {
			binary += String.fromCharCode(byte);
		}
		return window.btoa(binary);
	}

	base64ToArrayBuffer(base64: string): ArrayBuffer {
		const binary = window.atob(base64);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
		return bytes.buffer;
	}

	async apiRequest(endpoint: string, method = 'GET', body?: unknown) {
		const response = await requestUrl({
			url: `${this.settings.serverUrl}${endpoint}`,
			method,
			headers: {
				Authorization: `Bearer ${this.settings.apiKey}`,
				'Content-Type': 'application/json',
			},
			body: body ? JSON.stringify(body) : undefined,
		});
		if (response.status >= 400) {
			throw new Error(
				`Server returned HTTP ${response.status} for ${method} ${endpoint}`,
			);
		}
		const json: unknown = response.json;
		return json;
	}

	async runSync(silent = false) {
		if (this.isSyncing) {
			this.pendingSync = true;
			return;
		}
		this.isSyncing = true;
		if (!silent) new Notice('Starting homeserver sync...');

		try {
			// 1. Fetch remote manifest
			const remoteManifest: Record<
				string,
				{ hash: string; mtime: number }
			> = (await this.apiRequest('/api/manifest')) as Record<string, { hash: string; mtime: number }>;

			// 2. Build local manifest. The hash cache skips re-reading files
			// whose mtime+size are unchanged since the last sync.
			const localPaths = await this.walkAdapterFiles('');
			const localMap = new Map<string, string>(); // path -> hash

			for (const path of localPaths) {
				const stat = await this.app.vault.adapter.stat(path);
				const cached = this.settings.localHashCache[path];
				if (
					stat &&
					cached &&
					cached.mtime === stat.mtime &&
					cached.size === stat.size
				) {
					localMap.set(path, cached.hash);
					continue;
				}
				const buffer = await this.app.vault.adapter.readBinary(path);
				const hash = await this.hashBuffer(buffer);
				localMap.set(path, hash);
				this.settings.localHashCache[path] = {
					mtime: stat?.mtime ?? 0,
					size: stat?.size ?? 0,
					hash,
				};
			}
			// Drop cache entries for files that no longer exist locally
			for (const cachedPath of Object.keys(this.settings.localHashCache)) {
				if (!localMap.has(cachedPath))
					delete this.settings.localHashCache[cachedPath];
			}

			const allPaths = new Set([
				...Object.keys(remoteManifest).filter(
					(p) => !this.isExcluded(p),
				),
				...localMap.keys(),
				...Object.keys(this.settings.lastSyncedHashes).filter(
					(p) => !this.isExcluded(p),
				),
			]);

			const newSyncedHashes: Record<string, string> = {};
			let changesApplied = 0;
			const failedFiles: string[] = [];

			for (const path of allPaths) {
				try {
					changesApplied += await this.syncPath(
						path,
						localMap.get(path),
						remoteManifest[path],
						this.settings.lastSyncedHashes[path],
						newSyncedHashes,
					);
				} catch (err) {
					// One failing file must not abort the whole sync
					console.error(`Sync failed for ${path}:`, err);
					failedFiles.push(path);
				}
			}

			this.settings.lastSyncedHashes = newSyncedHashes;
			await this.saveSettings();

			if (!silent || changesApplied > 0 || failedFiles.length > 0) {
				let msg = `Sync complete, applied ${changesApplied} changes`;
				if (failedFiles.length > 0)
					msg += `, ${failedFiles.length} failed (${failedFiles.join(', ')})`;
				new Notice(msg);
			}
		} catch (err) {
			console.error('Sync failed:', err);
			const message = err instanceof Error ? err.message : String(err);
			new Notice(`Sync failed: ${message}`);
		} finally {
			this.isSyncing = false;
			if (this.pendingSync) {
				this.pendingSync = false;
				this.debouncedSync();
			}
		}
	}

	// syncPath reconciles a single file between the local vault, the remote
	// manifest and the last synced state. Returns the number of changes
	// applied (0 or 1) and records the new hash in newSyncedHashes.
	async syncPath(
		path: string,
		localHash: string | undefined,
		remote: { hash: string; mtime: number } | undefined,
		lastHash: string | undefined,
		newSyncedHashes: Record<string, string>,
	): Promise<number> {
		// Case A: Exists on both sides
		if (localHash !== undefined && remote) {
			if (localHash === remote.hash) {
				newSyncedHashes[path] = localHash;
				return 0;
			}
			if (localHash === lastHash) {
				// Remote changed -> Pull
				await this.pullFile(path);
				newSyncedHashes[path] = remote.hash;
				return 1;
			}
			if (remote.hash === lastHash) {
				// Local changed -> Push
				await this.pushFile(path);
				newSyncedHashes[path] = localHash;
				return 1;
			}
			// Both changed -> keep a conflict copy of the local version, then pull remote
			const conflictPath = path.replace(
				/(\.[^./]+)?$/,
				`.conflict-${Date.now()}$1`,
			);
			const localBuffer = await this.app.vault.adapter.readBinary(path);
			await this.app.vault.adapter.writeBinary(conflictPath, localBuffer);
			await this.pullFile(path);
			newSyncedHashes[path] = remote.hash;
			new Notice(
				`Conflict on ${path}: local copy saved as ${conflictPath}, remote version pulled`,
			);
			return 1;
		}
		// Case B: Only exists locally
		if (localHash !== undefined && !remote) {
			if (lastHash) {
				// Was previously synced, so it was deleted on the server -> remove locally
				await this.app.vault.adapter.remove(path);
			} else {
				// Brand new local file -> Push
				await this.pushFile(path);
				newSyncedHashes[path] = localHash;
			}
			return 1;
		}
		// Case C: Only exists remotely
		if (localHash === undefined && remote) {
			if (lastHash) {
				// Was previously synced, so it was deleted locally -> delete on server
				await this.apiRequest(
					`/api/file?path=${encodeURIComponent(path)}`,
					'DELETE',
				);
			} else {
				// Brand new remote file -> Pull
				await this.pullFile(path);
				newSyncedHashes[path] = remote.hash;
			}
			return 1;
		}
		return 0;
	}

	async pushFile(path: string) {
		const buffer = await this.app.vault.adapter.readBinary(path);
		await this.apiRequest('/api/file', 'PUT', {
			path,
			contentBase64: this.arrayBufferToBase64(buffer),
		});
	}

	async pullFile(path: string) {
		const data = (await this.apiRequest(
			`/api/file?path=${encodeURIComponent(path)}`,
		)) as { contentBase64: string };
		const buffer = this.base64ToArrayBuffer(data.contentBase64);

		// Ensure parent folders exist
		const folderPath = path.split('/').slice(0, -1).join('/');
		if (folderPath && !(await this.app.vault.adapter.exists(folderPath))) {
			await this.app.vault.adapter.mkdir(folderPath);
		}

		await this.app.vault.adapter.writeBinary(path, buffer);
	}

	async loadSettings() {
		const stored = (await this.loadData()) as Partial<SyncSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
