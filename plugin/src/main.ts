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
			this.runSync(true);
		},
		5000,
		true,
	); // Wait 5sec after typing, then run synd

	async onload() {
		await this.loadSettings();

		// Ribbon icon to trigger manual sync
		this.addRibbonIcon('refresh-cw', 'Sync with Homeserver', () => {
			this.runSync(false);
		});

		// Command palette entry
		this.addCommand({
			id: 'trigger-homeserver-sync',
			name: 'Sync vault with homeserver',
			callback: () => this.runSync(false),
		});

		this.addSettingTab(new VaultyPluginSettingTab(this.app, this));

		// Register vault event triggers (needs to wait for layout)
		this.app.workspace.onLayoutReady(() => {
			this.runSync(true);

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
					this.runSync(true);
				}
			}, this.settings.autoSyncIntervalSeconds * 1000),
		);
	}

	onLocalChange(path: string) {
		if (this.isSyncing) return;
		if (this.isExcluded(path)) return;
		this.debouncedSync();
	}

	isExcluded(path: string): boolean {
		if (EXCLUDED_PATHS.has(path)) return true;
		if (!this.settings.syncSettingsFolder && path.startsWith('./obsidian/'))
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
		for (let i = 0; i < bytes.byteLength; i++) {
			binary += String.fromCharCode(bytes[i]);
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
		return response.json;
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
			> = await this.apiRequest('/api/manifest');

			// 2. Build local manifest
			const localPaths = await this.walkAdapterFiles('');
			const localMap = new Map<
				string,
				{ hash: string; buffer: ArrayBuffer }
			>();

			for (const path of localPaths) {
				const buffer = await this.app.vault.adapter.readBinary(path);
				const hash = await this.hashBuffer(buffer);
				localMap.set(path, { hash, buffer });
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

			for (const path of allPaths) {
				const local = localMap.get(path);
				const remote = remoteManifest[path];
				const lastHash = this.settings.lastSyncedHashes[path];

				// Case A: Exists on both sides
				if (local && remote) {
					if (local.hash === remote.hash) {
						newSyncedHashes[path] = local.hash;
					} else if (local.hash === lastHash) {
						// Remote changed -> Pull
						await this.pullFile(path);
						newSyncedHashes[path] = remote.hash;
						changesApplied++;
					} else if (remote.hash === lastHash) {
						// Local changed -> Push
						await this.pushFile(path, local.buffer);
						newSyncedHashes[path] = local.hash;
						changesApplied++;
					} else {
						// Both changed -> Save conflict copy and pull remote
						const conflictPath = path.replace(
							/(\.[^.]+)$/,
							`.conflict-${Date.now()}$1`,
						);
						await this.app.vault.adapter.writeBinary(
							conflictPath,
							local.buffer,
						);
						await this.pullFile(path);
						newSyncedHashes[path] = remote.hash;
						changesApplied++;
						new Notice(`Conflict resolved for ${path}`);
					}
				}
				// Case B: Only exists locally
				else if (local && !remote) {
					if (lastHash) {
						// Was previously synced, so it was deleted on server -> Trash locally
						await this.app.vault.adapter.remove(path);
						changesApplied++;
					} else {
						// Brand new local file -> Push
						await this.pushFile(path, local.buffer);
						newSyncedHashes[path] = local.hash;
						changesApplied++;
					}
				}
				// Case C: Only exists remotely
				else if (!local && remote) {
					if (lastHash) {
						// Was previously synced, so it was deleted locally -> Delete on server
						await this.apiRequest(
							`/api/file?path=${encodeURIComponent(path)}`,
							'DELETE',
						);
						changesApplied++;
					} else {
						// Brand new remote file -> Pull
						await this.pullFile(path);
						newSyncedHashes[path] = remote.hash;
						changesApplied++;
					}
				}
			}

			this.settings.lastSyncedHashes = newSyncedHashes;
			await this.saveSettings();

			if (!silent || changesApplied > 0) {
				new Notice(`Sync complete, applied ${changesApplied} changes`);
			}
		} catch (err) {
			console.error('Sync failed:', err);
			new Notice(`Sync failed: ${err.message}`);
		} finally {
			this.isSyncing = false;
			if (this.pendingSync) {
				this.pendingSync = false;
				this.debouncedSync();
			}
		}
	}

	async pushFile(path: string, buffer: ArrayBuffer) {
		await this.apiRequest('/api/file', 'PUT', {
			path,
			contentBase64: this.arrayBufferToBase64(buffer),
		});
	}

	async pullFile(path: string) {
		const data = await this.apiRequest(
			`/api/file?path=${encodeURIComponent(path)}`,
		);
		const buffer = this.base64ToArrayBuffer(data.contentBase64);

		// Ensure parent folders exist
		const folderPath = path.split('/').slice(0, -1).join('/');
		if (folderPath && !(await this.app.vault.adapter.exists(folderPath))) {
			await this.app.vault.adapter.mkdir(folderPath);
		}

		await this.app.vault.adapter.writeBinary(path, buffer);
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData(),
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
