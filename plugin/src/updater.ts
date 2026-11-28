import { Notice, requestUrl } from 'obsidian';
import VaultyPlugin from './main';

// Public GitHub repo that hosts the plugin releases (tags: plugin-v*.*.*)
const REPO = 'TimsGarage/vaulty';

// Assets that make up a plugin release; styles.css is optional
const REQUIRED_ASSETS = ['main.js', 'manifest.json'];
const OPTIONAL_ASSETS = ['styles.css'];

interface GithubAsset {
	name: string;
	browser_download_url: string;
}

interface GithubRelease {
	tag_name: string;
	assets: GithubAsset[];
}

type Version = [number, number, number];

function parseTagVersion(tag: string): Version | null {
	const m = /^plugin-v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
	if (!m) return null;
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function parseManifestVersion(version: string): Version | null {
	const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	if (!m) return null;
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareVersions(a: Version, b: Version): number {
	for (let i = 0; i < 3; i++) {
		const av = a[i] ?? 0;
		const bv = b[i] ?? 0;
		if (av !== bv) return av - bv;
	}
	return 0;
}

/**
 * Checks GitHub for a newer plugin release and, if found, downloads the
 * release assets into the plugin folder. The user must reload Obsidian
 * for the new version to take effect.
 */
export async function checkForUpdates(
	plugin: VaultyPlugin,
	silent = false,
): Promise<void> {
	try {
		const res = await requestUrl({
			url: `https://api.github.com/repos/${REPO}/releases?per_page=20`,
			headers: {
				Accept: 'application/vnd.github+json',
				'User-Agent': 'vaulty-plugin',
			},
		});
		if (res.status >= 400) {
			throw new Error(`GitHub API returned HTTP ${res.status}`);
		}
		const releases = res.json as GithubRelease[];

		// Pick the highest plugin-v*.*.* release
		let best: { version: Version; release: GithubRelease } | null = null;
		for (const release of releases) {
			const version = parseTagVersion(release.tag_name);
			if (version && (!best || compareVersions(version, best.version) > 0)) {
				best = { version, release };
			}
		}
		if (!best) {
			if (!silent) new Notice('No Vaulty release found on GitHub');
			return;
		}

		const current = parseManifestVersion(plugin.manifest.version);
		if (!current) {
			throw new Error(`Cannot parse current version ${plugin.manifest.version}`);
		}
		if (compareVersions(best.version, current) <= 0) {
			if (!silent) new Notice(`Vaulty is up to date (v${current.join('.')})`);
			return;
		}

		// Download release assets into the plugin directory
		const dir = plugin.manifest.dir;
		if (!dir) throw new Error('Cannot determine plugin directory');

		for (const name of [...REQUIRED_ASSETS, ...OPTIONAL_ASSETS]) {
			const asset = best.release.assets.find((a) => a.name === name);
			if (!asset) {
				if (REQUIRED_ASSETS.includes(name))
					throw new Error(`Release ${best.release.tag_name} is missing ${name}`);
				continue;
			}
			const dl = await requestUrl({ url: asset.browser_download_url });
			if (dl.status >= 400) {
				throw new Error(`Download of ${name} failed with HTTP ${dl.status}`);
			}
			await plugin.app.vault.adapter.writeBinary(
				`${dir}/${name}`,
				dl.arrayBuffer,
			);
		}

		new Notice(
			`Vaulty updated to v${best.version.join('.')} — reload Obsidian to apply the update`,
			10000,
		);
	} catch (err) {
		console.error('Vaulty update check failed:', err);
		if (!silent) {
			const message = err instanceof Error ? err.message : String(err);
			new Notice(`Update check failed: ${message}`);
		}
	}
}
