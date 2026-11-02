/*
 * @Description: 
 * @FilePath: \wallpaper-studio\src\extension.ts
 */
'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import {
	commands,
	window,
	Extension,
	extensions,
	ExtensionContext,
	StatusBarAlignment,
	version as vscodeVersion,
} from 'vscode';
import * as fs from 'fs';
import { PickList } from './PickList';
import { setContext } from './global';
import { CUSTOM_JS_FILE_PATH, collectStaleWindowCssFiles, detectPatchState } from './FileDom';
import { startBackgroundSoftWrite, stopBackgroundSoftWrite } from './backgroundSoftWrite';
import { StudioViewProvider } from './StudioViewProvider';
import { hasCurrentImageRecord, resolveCurrentImagePath, setCurrentBlur, setCurrentOpacity } from './windowBackground';
import { getAppConfig, onDidChangeSettings } from './settingsStore';


export function activate(context: ExtensionContext) {
	setContext(context);
	// 创建底部按钮 - 背景图片配置
	let backImgBtn = window.createStatusBarItem(StatusBarAlignment.Right, -999);
	backImgBtn.text = '$(file-media)';
	backImgBtn.command = 'extension.wallpaperStudio.showMenu';
	backImgBtn.tooltip = 'Switch background image / 切换背景图';
	backImgBtn.show();
	context.subscriptions.push(backImgBtn);

	// 创建底部按钮 - 粒子效果配置
	
	// 异步检查 VSCode 版本变化，不阻塞启动
	checkVSCodeVersionChanged(context).then(async isChanged => {
		if (!isChanged) {
			const config = getAppConfig();
			const resolved = resolveCurrentImagePath(config.imagePath || '');
			const hasImage = !!resolved || hasCurrentImageRecord();

			// A1: 以实际内核文件的内容标记判定补丁状态（none/legacy/latest）。
			// 覆盖"同一版本重装 VS Code / 用户手动还原 workbench 文件 / 打过旧版补丁"
			// 这些仅凭版本号或文件存在性检测不到的丢失场景。
			const patchState = await detectPatchState();
			// 补丁标记还在、但加载器文件被删掉（清理产物 / 手动删除）时，内核里的
			// 注入块会 import 到一个不存在的文件，表现是「面板预览正常、背景空白」。
			// 这种情况不需要问用户，直接补写产物即可，问一遍反而让人误以为没什么事。
			const loaderMissing = !fs.existsSync(CUSTOM_JS_FILE_PATH);
			const patchOutdated = patchState !== 'latest';

			if (hasImage && loaderMissing) {
				try {
					await PickList.applyCurrentBackground();
				} catch (error) {
					console.warn('[WallpaperStudio] failed to restore missing loader:', error);
				}
			} else if (hasImage && patchOutdated) {
				const ex: Extension<any> | undefined = extensions.getExtension('Alinn.wallpaper-studio');
				const extensionVersion: string = ex ? ex.packageJSON['version'] : '';
				window.showInformationMessage(
					`WallpaperStudio ${extensionVersion || ''}：检测到背景补丁缺失或版本过旧，需要重新应用。是否立即执行？ / WallpaperStudio ${extensionVersion || ''}: Background patch is missing or outdated. Apply it now?`,
					'Apply / 应用',
					'Later / 稍后'
				).then(async result => {
					if (result === 'Apply / 应用') {
						const requiresReload = await PickList.applyCurrentBackground();
						if (requiresReload) {
							await promptRestartWindow();
						}
					}
				});
			} else {
				if (hasImage) {
					await PickList.applyCurrentBackground();
				}
			}
		}
	}).catch(err => {
		console.error('[WallpaperStudio] startup apply failed:', err);
	});

	// 启动自动更换任务
	PickList.startAutoRandomTask();

	// 回收历史窗口会话遗留的 CSS 文件，不阻塞启动
	void collectStaleWindowCssFiles();

	// 软写入保活：定期把当前壁纸同步到共享 CSS，并清理过期会话文件，
	// 这样下次打开 VS Code 立刻就有背景，目录也不会越堆越大。
	startBackgroundSoftWrite();

	// 收敛在线图片缓存目录：无扩展名在线源每次换图都会新增缓存文件，长期自动换图
	// 会让 images/ 无限增长（#233）。启动时清一次超过上限的最旧文件，不阻塞启动。

	// 监听设置变化（扩展自有的全局设置文件，跨 profile 共享）
	context.subscriptions.push(onDidChangeSettings(changed => {
		if (changed.includes('autoStatus') || changed.includes('autoInterval')) {
			PickList.startAutoRandomTask();
		}
		if (changed.includes('perWindowBackground')) {
			// 切换独立/共用模式：重新应用一次，让本窗口写到新的目标 CSS 文件，
			// 并把注入端的地址复位。其余窗口各自收到同一事件后自行处理。
			void PickList.applyCurrentBackground();
		}
	}));

	let randomCommand = commands.registerCommand('extension.wallpaperStudio.refresh', () => { PickList.randomUpdateBackground(); });
	let startCommand = commands.registerCommand('extension.wallpaperStudio.start', () => { 
		commands.executeCommand('setContext', 'wallpaperStudio.mode', 'menu');
		commands.executeCommand('workbench.view.extension.wallpaperStudio-explorer');
	});
	let showMenuCommand = commands.registerCommand('extension.wallpaperStudio.showMenu', () => {
		commands.executeCommand('setContext', 'wallpaperStudio.mode', 'menu');
		commands.executeCommand('workbench.view.extension.wallpaperStudio-explorer');
	});
	context.subscriptions.push(startCommand);
	context.subscriptions.push(randomCommand);
	context.subscriptions.push(showMenuCommand);

	// New Vue-powered Studio webview (primary configuration UI)
	const studioViewProvider = new StudioViewProvider(context);
	// 扩展激活只预热轻量索引；完整播放列表在面板打开时加载，避免启动阶段阻塞。
	void Promise.resolve().then(() => studioViewProvider.prewarm());
	context.subscriptions.push(window.registerWebviewViewProvider(
		StudioViewProvider.viewType,
		studioViewProvider,
		{ webviewOptions: { retainContextWhenHidden: true } }
	));

	context.subscriptions.push(
		commands.registerCommand('wallpaperStudio.refreshEntry', () => {
			commands.executeCommand('setContext', 'wallpaperStudio.mode', 'menu');
			studioViewProvider.refresh();
		}),
		commands.registerCommand('wallpaperStudio.home', () => {
			commands.executeCommand('setContext', 'wallpaperStudio.mode', 'menu');
			studioViewProvider.navigate('home');
		}),
		commands.registerCommand('wallpaperStudio.switchMode', () => {
			commands.executeCommand('setContext', 'wallpaperStudio.mode', 'menu');
			studioViewProvider.navigate('home');
		})
	);

	// Register Command for Tree Item Click
	context.subscriptions.push(commands.registerCommand('wallpaperStudio.runAction', async (type: number, path?: string) => {
		const config = getAppConfig();
		// No QuickPick: webview-originated actions must not flash a native popup
		// or open the legacy "Reloading takes effect?" prompt. The Studio panel
		// is the user-facing UI now.
		const pickList = new PickList(config);
		await pickList.handleAction(type, path);
	}));


	context.subscriptions.push(commands.registerCommand('wallpaperStudio.setConfig', async (key: string, value: any) => {
		if (key === 'wallpaperStudio.imagePath') {
			// All sources use the same PickList -> FileDom application boundary.
			await PickList.applyBackgroundPath(typeof value === 'string' ? value : '');
			return;
		}
		const config = getAppConfig();
		if (key === 'wallpaperStudio.opacity' || key === 'wallpaperStudio.blur') {
			// 独立模式下透明度/模糊度按窗口+工作区记录在 globalState 里，让每个
			// 窗口的 webview 显示各自的值；共用模式下才回写全局 settings.json。
			const num = typeof value === 'number' ? value : parseFloat(value);
			if (Number.isNaN(num)) { return; }
			if (key === 'wallpaperStudio.opacity') {
				await setCurrentOpacity(num, config);
			} else {
				await setCurrentBlur(num, config);
			}
			// 配置对象是快照，保存后重新读取，避免共享模式应用上一次的值。
			PickList.needAutoUpdate(getAppConfig());
			return;
		}
		await config.update(key.replace(/^wallpaperStudio\./, ''), value, true);
		if (key === 'wallpaperStudio.perWindowBackground') {
			// 重新应用交给 onDidChangeConfiguration 统一处理，避免连开两次。
			return;
		}
		PickList.needAutoUpdate(getAppConfig());
	}));

	// Initialize context
	commands.executeCommand('setContext', 'wallpaperStudio.mode', 'menu');

	// A4: 主题感知混合模式已改为注入 CSS 的变量 + :has() 即时适配（见 backgroundCss.ts），
	// 不再需要监听主题变化并弹窗确认 / 重打补丁 / 重载窗口。



	// 首次打开/版本更新弹窗已移除：每次升级都弹一个赞助提示会打断使用，
	// 版本信息统一放 CHANGELOG.md，赞助入口在面板 Home 页的 About 卡片里。
}

// 检查 VSCode 版本是否变化
async function checkVSCodeVersionChanged(context: ExtensionContext): Promise<boolean> {
	// 获取配置
	let config = getAppConfig();
	const resolved = resolveCurrentImagePath(config.imagePath || '');
	if (!resolved && !hasCurrentImageRecord()) {
		return false;
	}

	// 从全局状态中获取上次记录的 VSCode 版本
	let lastVSCodeVersion = context.globalState.get('vscode_version');
	// 如果版本不同，说明 VSCode 更新了
	if (lastVSCodeVersion && lastVSCodeVersion !== vscodeVersion) {
		// 弹出提示框确认是否更新背景
		const value = await window.showInformationMessage(
			`检测到 VS Code 已从 ${lastVSCodeVersion} 更新到 ${vscodeVersion}，背景补丁可能已被重置。是否重新应用并重载窗口？ / VS Code was updated from ${lastVSCodeVersion} to ${vscodeVersion}. Reapply the background patch and reload the window?`,
			'Apply and Reload / 应用并重载',
			'Later / 稍后'
		);

		if (value === 'Apply and Reload / 应用并重载') {
			// Update the stored version BEFORE any operation that might reload/close the window
			await context.globalState.update('vscode_version', vscodeVersion);

			// Apply the background patch
			const requiresReload = await PickList.applyCurrentBackground();
			if (requiresReload) {
				// VSCode updates replace workbench files; the Electron main process has
				// already cached the compiled bytecode of the old (unpatched) workbench.
				// A soft reload (workbench.action.reloadWindow) only rebuilds the renderer
				// process and still pulls from the stale cache. A full restart is required
				// to clear the main process cache and recompile the patched file.
				await promptRestartWindow();
			} else {
				window.setStatusBarMessage('Background already applied. / 背景已应用。', 5000);
			}
		} else {
			// User chose "Later / 稍后" — still update the version so we don't prompt again
			await context.globalState.update('vscode_version', vscodeVersion);
		}

		return true;
	}

	// 修复：首次运行或版本未记录时，也需要更新版本号，防止下次误判
	if (!lastVSCodeVersion) {
		await context.globalState.update('vscode_version', vscodeVersion);
	}

	return false;
}

async function promptRestartWindow(): Promise<void> {
	const value = await window.showInformationMessage(
		'背景补丁已应用，但需要完全关闭并重新打开 VS Code 才能生效（软重载不会清除编译缓存）。是否现在退出？ / Background patch applied. You must fully quit and restart VS Code for it to take effect (soft reload won\'t clear the compilation cache). Quit now?',
		'Quit / 退出',
		'Later / 稍后'
	);
	if (value === 'Quit / 退出') {
		await commands.executeCommand('workbench.action.quit');
	}
}

// this method is called when your extension is deactivated
export function deactivate() {
	PickList.stopAutoRandomTask();
	stopBackgroundSoftWrite();
}
