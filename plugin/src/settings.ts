import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import VaultyPlugin from './main';

export interface SyncSettings {
	serverUrl: string;
	apiKey: string;
	syncSettingsFolder: boolean;
	autoSyncIntervalSeconds: number;
	lastSyncedHashes: Record<string, string>; // Tracks state from the last successful sync
	// Cache of local file hashes keyed by path, used to skip re-hashing
	// files whose mtime+size have not changed since the last sync.
	localHashCache: Record<string, { mtime: number; size: number; hash: string }>;
}

export const DEFAULT_SETTINGS: SyncSettings = {
	serverUrl: 'http://192.168.1.100:3000',
	apiKey: 'change-me-to-a-strong-secret',
	syncSettingsFolder: true,
	autoSyncIntervalSeconds: 60,
	lastSyncedHashes: {},
	localHashCache: {},
};

export const EXCLUDED_PATHS = new Set([
	'.obsidian/workspace.json',
	'.obsidian/workspace-mobile.json',
	'.obsidian/plugins/vaulty/data.json',
	'.DS_Store',
	'Thumbs.db',
]);

export class VaultyPluginSettingTab extends PluginSettingTab {
	plugin: VaultyPlugin;
	constructor(app: App, plugin: VaultyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Homeserver URL')
			.setDesc(
				'Base URL of your sync API (e.g., http://192.168.1.100:3000)',
			)
			.addText((text) =>
				text
					.setValue(this.plugin.settings.serverUrl)
					.onChange(async (value) => {
						const url = value.replace(/\/$/, '');
						this.plugin.settings.serverUrl = url;
						await this.plugin.saveSettings();
						if (
							url &&
							!url.startsWith('https://') &&
							!/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url)
						) {
							new Notice(
								'Warning: non-HTTPS URL — your API key is sent in cleartext. Use HTTPS unless this is a trusted local network.',
								8000,
							);
						}
					}),
			);

		new Setting(containerEl)
			.setName('API Key')
			.setDesc('Bearer token configured on your homeserver')
			.addText((text) =>
				text
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Sync .obsidian settings folder')
			.setDesc('Sync themes, snippets, hotkeys, and community plugins')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.syncSettingsFolder)
					.onChange(async (value) => {
						this.plugin.settings.syncSettingsFolder = value;
						await this.plugin.saveSettings();
					}),
			);
	}
}
