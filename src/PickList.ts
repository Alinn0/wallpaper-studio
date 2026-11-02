import * as fs from 'fs';
import * as path from 'path';
import {
	QuickPick,
	Disposable,
	WorkspaceConfiguration,
	window,
	commands,
	env,
	Uri,
	extensions,
	InputBoxOptions,
	ConfigurationTarget,
    OutputChannel
} from 'vscode';

import { FileDom, getActiveWindowCssFile, patchScenePropertiesInCss } from './FileDom';
import { BackgroundPatchError, BackgroundApplyCancelledError, shouldTryNextAutoImage, pickUnusedCandidate } from './downloadError';
import { ImgItem } from './ImgItem';
import vsHelp from './vsHelp';
import { getContext } from './global';
import { hasCurrentImageRecord, resolveCurrentBlur, resolveCurrentImagePath, resolveCurrentOpacity, setCurrentBlur, setCurrentImagePath, setCurrentOpacity } from './windowBackground';
import { getCandidatesForMode, getRandomCandidates, getSourceMode, setSourceMode } from './sourceMode';
import { expandPathVariables, isSupportedMedia, pickRandomFromFolder } from './pathUtil';
import { getAppConfig } from './settingsStore';
import { ActionType } from './webviewProtocol';


export { ActionType };

// Input Types Enum
enum InputType {
    Path = 1,
    Opacity = 2,
    Blur = 3,
    AutoRandomSettings = 4,
}


interface UpdateBackgroundOptions {
    skipLargeImagePrompt?: boolean;
}

const AUTO_IMAGE_ATTEMPTS = 3;




export class PickList {
    public static itemList: PickList | undefined;
    private static intervalHandle: NodeJS.Timeout | undefined;
    private static autoRefreshOutput: OutputChannel | undefined;
    private static isAutoRunning: boolean = false;
    private static _reloadTriggerSeq: number = 0;
    private static _updateSeq: number = 0;

    private readonly quickPick: QuickPick<ImgItem> | any;
    private _disposables: Disposable[] = [];
    private config: WorkspaceConfiguration;
    private imgPath: string;
    private opacity: number;
    private imageFileType: number;
    private sizeModel: string;
    private blur: number;
    private randUpdate: boolean = false;
    private silentApply: boolean = false;

    // --- Static Entry Points ---

    public static needAutoUpdate(config: WorkspaceConfiguration) {
        if (!resolveCurrentImagePath(config.imagePath || '')) { return; }

        PickList.itemList = new PickList(config);
        PickList.itemList.updateDom(false).then((requiresReload) => {
            if (requiresReload) {
                // Avoid auto-reloading: the Studio "Reload to apply" button in
                // here. We just
                // hint via the status bar so they know the change is staged.
                window.setStatusBarMessage(
                    '部分修改需重启窗口生效（装饰栏 → 重启生效） / Restart required for some changes.',
                    6000
                );
            }

        }).catch(error => {
            console.error("Error updating the DOM:", error);
        });
    }

    /**
     * Single background application boundary used by the Studio, legacy actions,
     * folder rotation and Wallpaper Engine playlists. Every source therefore
     * receives the same validation, scene-package preparation and FileDom path.
     */
    public static async applyBackgroundPath(
        imagePath: string,
        options: { persist?: boolean; silent?: boolean } = {}
    ): Promise<boolean> {
        const config = getAppConfig();
        const item = new PickList(config);
        if (options.silent) { item.setRandUpdate(true); }
        try {
            return Boolean(await item.updateBackgound(
                imagePath,
                options.persist ?? true,
                { skipLargeImagePrompt: true }
            ));
        } finally {
            PickList.itemList = undefined;
        }
    }

    /**
     * A4: 主题感知混合模式已改为注入 CSS 的变量 + :has() 即时适配，主题切换不再需要
     * 扩展侧监听/弹窗确认/重打补丁，此方法随旧机制一并移除。
     */

    /**
     * 定时轮播：**严格按当前来源模式抽候选**。
     *
     * 旧实现只看 `wallpaperStudioWallpaperEnabled`，而这个键与真正生效的
     * `wallpaperStudioSourceMode` 是两套判定（两个模块读它的默认值还不一样），
     * 于是 Wallpaper 模式下定时器也会去 `randomImageFolder` 抽图 —— 表现为
     * "随机会随机到别的模式的壁纸"。
     */
    public static autoUpdateBackground() {
        return PickList.randomForCurrentMode();
    }

    /** 在当前模式内随机换一张（定时器与手动随机共用）。 */
    private static randomForCurrentMode(): boolean {
        const config = getAppConfig();
        const current = resolveCurrentImagePath(config.get<string>('imagePath') || '');
        const candidates = getRandomCandidates(current);
        if (!candidates.length) { return false; }
        const next = candidates[Math.floor(Math.random() * candidates.length)];
        void PickList.applyBackgroundPath(next, { persist: true, silent: true });
        return true;
    }

    public static randomUpdateBackground() {
        const mode = getSourceMode();
        const candidates = getCandidatesForMode(mode);
        if (!candidates.length) {
            window.showWarningMessage(
                mode === 'wallpaper'
                    ? '当前模式没有可用的壁纸（请选择 Wallpaper 配置文件） / No wallpapers in the current mode.'
                    : mode === 'folder'
                        ? '请先添加目录 / Please add a directory first.'
                        : '请先选择壁纸 / Please pick some wallpapers first.'
            );
            return false;
        }
        return PickList.randomForCurrentMode();
    }

    /**
     * 通知注入端重读样式/重载脚本。每次都用新的序号，保证 MutationObserver
     * 一定能看到一次文本变化（文本相同的话 VSCode 可能不触发 mutation）。
     */
    private static fireReloadTrigger(kind: 'css' | 'js', token: string): void {
        PickList._reloadTriggerSeq += 1;
        const triggerText = `wallpaper-studio-reload-trigger:${kind}:${PickList._reloadTriggerSeq}:${token}`;
        const triggerMsg = window.setStatusBarMessage(triggerText);
        setTimeout(() => triggerMsg.dispose(), 1000);
    }

    /**
     * 立即应用壁纸用户配置 / XY 视角，不重装背景。
     *
     * 只改写当前窗口 CSS 里的场景配置块并触发一次样式重读；注入端收到后会向
     * 场景 iframe 发送 `set-properties`，因此拖动滑块的过程也能实时生效。
     * 返回 false 表示当前背景不是场景包，调用方无需继续处理。
     */
    public static async applySceneProperties(properties: Record<string, unknown>): Promise<boolean> {
        const patched = await patchScenePropertiesInCss(properties);
        if (!patched) { return false; }
        PickList.fireReloadTrigger('css', getActiveWindowCssFile().token);
        return true;
    }

    public static async applyCurrentBackground(): Promise<boolean> {
        const config = getAppConfig();
        const resolved = resolveCurrentImagePath(config.get<string>('imagePath') || '');

        // 壁纸文件被移动/删除（例如用户整理了壁纸目录）时：
        // 不要把一份指向空文件的 CSS 写进 workbench —— 那会让背景空白，
        // 同时让 VS Code 一直认为安装被改坏。这里直接提示并优雅清除背景
        // （clearBackground 会保留「隐藏损坏提示」的样式）。
        if (resolved && !fs.existsSync(resolved)) {
            window.showWarningMessage(
                `壁纸文件已丢失，已清除背景：${resolved}`
            );
            PickList.itemList = new PickList(config);
            try {
                await PickList.itemList.updateDom(true);
            } catch (error) {
                console.error('[WallpaperStudio] Failed to clear missing background:', error);
            } finally {
                PickList.itemList = undefined;
            }
            return false;
        }

        if (!resolved && !hasCurrentImageRecord()) {
            return false;
        }
        if (resolved) {
            await setCurrentImagePath(resolved);
        }
        PickList.itemList = new PickList(config);
        const result = resolved
            ? await PickList.itemList.updateDom(false)
            : await PickList.itemList.updateDom(true);
        PickList.itemList = undefined;
        return result;
    }

    public static startAutoRandomTask() {
        const config = getAppConfig();
        const autoStatus = config.get<boolean>('autoStatus');
        const interval = config.get<number>('autoInterval', 10);

        PickList.stopAutoRandomTask();

        if (autoStatus && interval > 0) {
            PickList.logAutoRefresh(`Timer started. Interval: ${interval}s.`);
            PickList.intervalHandle = setInterval(async () => {
                if (PickList.isAutoRunning) {
                    PickList.logAutoRefresh('Timer tick skipped: previous refresh is still running.');
                    return;
                }
                // 定时轮播同样只在**当前来源模式**内抽候选，绝不跨模式。
                // 旧实现按 wallpaperStudioWallpaperEnabled 分支，与真正生效的
                // wallpaperStudioSourceMode 是两套判定，于是 Wallpaper 模式下
                // 定时器也会从 randomImageFolder 抽图。
                const cfg = getAppConfig();
                const mode = getSourceMode();
                const candidates = getRandomCandidates(
                    resolveCurrentImagePath(cfg.get<string>('imagePath') || '')
                );
                if (candidates.length) {
                    PickList.logAutoRefresh(`Timer tick: refreshing in ${mode} mode (${candidates.length} candidates).`);
                    PickList.isAutoRunning = true;
                    try {
                        await PickList.randomForCurrentMode();
                        PickList.logAutoRefresh('Refresh cycle finished.');
                    } catch (err) {
                        PickList.logAutoRefresh('Refresh cycle failed; see extension host console for details.');
                        console.error(err);
                    } finally {
                        PickList.isAutoRunning = false;
                    }
                    return;
                }

            }, interval * 1000);
        }
    }

    private static logAutoRefresh(message: string): void {
        if (!PickList.autoRefreshOutput) {
            PickList.autoRefreshOutput = window.createOutputChannel('Wallpaper Studio');
            getContext().subscriptions.push(PickList.autoRefreshOutput);
        }
        PickList.autoRefreshOutput.appendLine(`[${new Date().toISOString()}] ${message}`);
    }

    public static stopAutoRandomTask() {
        if (PickList.intervalHandle) {
            clearInterval(PickList.intervalHandle);
            PickList.intervalHandle = undefined;
            PickList.logAutoRefresh('Timer stopped.');
        }
    }
    public static gotoFilePath(path?: string) {
        if (path == undefined) {
            return window.showWarningMessage('无效菜单');
        }
        const extensionUri = getContext().extensionUri ?? extensions.getExtension("Alinn.wallpaper-studio")?.extensionUri;
        if (!extensionUri) {
            return window.showWarningMessage('未找到扩展资源路径 / Extension resource path not found');
        }

        const segments = path.split(/[\\/]+/).filter(Boolean);
        const fileUri = Uri.joinPath(extensionUri, ...segments);
        commands.executeCommand('vscode.open', fileUri);
    }

    // --- Instance Methods ---

    public constructor(config: WorkspaceConfiguration, pickList?: QuickPick<ImgItem>) {
        this.config = config;
        this.imgPath = resolveCurrentImagePath(config.imagePath || '');
        // 独立模式下透明度/模糊度按窗口+工作区存储，这里解析出当前窗口实际生效的值，
        // 保证预览滑块起点与最终写入的 CSS 一致。
        this.opacity = resolveCurrentOpacity(config.opacity);
        this.sizeModel = config.sizeModel || 'cover';
        this.imageFileType = 0;
        this.blur = resolveCurrentBlur(config.blur);

        if (pickList) {
            this.quickPick = pickList;
            this.quickPick.onDidAccept(() => {
                if (this.quickPick.selectedItems.length > 0) {
                    this.handleAction(
                        this.quickPick.selectedItems[0].imageType,
                        this.quickPick.selectedItems[0].path
                    );
                }
            }, null, this._disposables);
            this.quickPick.onDidHide(() => {
                this.dispose();
            }, null, this._disposables);
            this.quickPick.show();
        }
    }

    public async handleAction(type: number, path?: string) {
        switch (type) {
            case ActionType.SelectPictures: await this.openFieldDialog(1); break;
            case ActionType.AddDirectory: await this.openFieldDialog(2); break;
            case ActionType.ManualSelection: await this.openFieldDialog(1); break;
            case ActionType.UpdateBackground: await this.updateBackgound(path); break;
            case ActionType.BackgroundOpacity: this.showOpacitySlider(); break;
            case ActionType.InputPath: this.showInputBox(InputType.Path); break;
            case ActionType.CloseBackground: await this.updateDom(true); break;
            case ActionType.ReloadWindow: commands.executeCommand('workbench.action.reloadWindow'); break;
            case ActionType.CloseMenu: this.quickPick.hide(); break;
            case ActionType.OpenExternalUrl: this.gotoPath(path); break;
            case ActionType.OpenFilePath: PickList.gotoFilePath(path); break;
            case ActionType.SetSizeMode: this.setSizeModel(path); break;
            case ActionType.BackgroundBlur: this.showBlurSlider(); break;
            case ActionType.AutoRandomSettings: this.showInputBox(InputType.AutoRandomSettings); break;
            case ActionType.OpenCacheFolder: this.openCacheFolder(); break;
            

            default: break;
        }
    }
    private gotoPath(path?: string) {
        if (path == undefined) { return window.showWarningMessage('无效菜单'); }
        env.openExternal(Uri.parse(path));
    }
    private dispose() {
        PickList.itemList = undefined;
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) { x.dispose(); }
        }
    }

    /**
     * 目录轮播的旧入口（保留给内部调用）。
     *
     * 在线图源（URL 目录 / 单图在线地址）已移除，这里只处理本地目录。
     * 定时器与"随机换一张"走的是 `sourceMode.getCandidatesForMode()`，
     * 本方法只作为历史兼容入口存在。
     */
    private async autoUpdateBackground(persist: boolean = true): Promise<boolean> {
        this.silentApply = !persist;
        const randomImageFolderCfg = this.config.get<string>('randomImageFolder');
        const randomImageFolder = this.resolveRandomFolder(randomImageFolderCfg);
        if (randomImageFolder) {
            const files = this.getFolderImgList(randomImageFolder).map(file => path.join(randomImageFolder, file));
            if (files.length > 0) {
                if (!persist) {
                    return await this.applyAutoCandidates(files, persist);
                }
                const randomFile = files[Math.floor(Math.random() * files.length)];
                await this.updateBackgound(randomFile, persist, { skipLargeImagePrompt: true });
            }
        }
        return true;
    }

    private async applyAutoCandidates(candidates: string[], persist: boolean): Promise<boolean> {
        const tried = new Set<string>();
        for (let i = 0; i < AUTO_IMAGE_ATTEMPTS; i++) {
            const next = pickUnusedCandidate(candidates, tried);
            if (!next) {
                break;
            }
            tried.add(next);
            try {
                await this.updateBackgound(next, persist, { skipLargeImagePrompt: true });
                return true;
            } catch (error) {
                if (error instanceof BackgroundApplyCancelledError || error instanceof BackgroundPatchError) {
                    return false;
                }
                console.error('[WallpaperStudio] Auto image update failed:', error);
                if (!shouldTryNextAutoImage(error)) {
                    return false;
                }
            }
        }
        window.setStatusBarMessage('自动换图失败，将在下个间隔再试 / Auto background update failed, will retry next interval.', 5000);
        return false;
    }

    /** 打开扩展的存储目录（缩略图缓存等都在这里）。在线图源已移除，不再有下载缓存。 */
    private openCacheFolder() {
        const context = getContext();
        const dir = context.globalStorageUri?.fsPath;
        if (!dir) { return; }
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        void env.openExternal(Uri.file(dir));
    }

    /** Push a path to the front of the recent-used list (globalState), keep at most 5. */
    private pushRecentImage(filePath: string): void {
        try {
            if (!filePath) { return; }
            const context = getContext();
            const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase();
            const prev = context.globalState.get<string[]>('wallpaperStudioRecentImages', []) || [];
            const next = [filePath, ...prev.filter((p) => normalize(p) !== normalize(filePath))].slice(0, 20);
            context.globalState.update('wallpaperStudioRecentImages', next);
        } catch (e) {
            console.warn('[WallpaperStudio] pushRecentImage failed:', e);
        }
    }

    public static listFolderImages(pathUrl: string): string[] {
        if (!pathUrl || pathUrl === '') { return []; }
        return fs.readdirSync(path.resolve(pathUrl)).filter((s) => isSupportedMedia(s));
    }

    private getFolderImgList(pathUrl: string): string[] {
        return PickList.listFolderImages(pathUrl);
    }

    /**
     * A3: 展开 randomImageFolder 中的 ~ / ${ENV} / $ENV 并校验是存在的目录；
     * 无效返回空串。
     */
    private resolveRandomFolder(input?: string): string {
        if (!input) { return ''; }
        const expanded = expandPathVariables(input);
        try {
            const resolved = path.resolve(expanded);
            if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
                return resolved;
            }
        } catch {
            // ignore
        }
        return '';
    }

    /**
     * Show an opacity slider with live preview.
     * Arrow keys preview each preset instantly; Enter commits; ESC restores.
     */
    private showOpacitySlider() {
        const presets: { value: number; label: string }[] = [
            { value: 0,    label: '0%   (Off / 关闭)' },
            { value: 0.05, label: '5%' },
            { value: 0.1,  label: '10%' },
            { value: 0.15, label: '15%' },
            { value: 0.2,  label: '20%  (Default / 默认)' },
            { value: 0.25, label: '25%' },
            { value: 0.3,  label: '30%' },
            { value: 0.4,  label: '40%' },
            { value: 0.5,  label: '50%' },
            { value: 0.6,  label: '60%' },
            { value: 0.7,  label: '70%' },
            { value: 0.8,  label: '80%  (Max / 最大)' },
        ];
        this.showSliderPicker(
            'opacity',
            this.opacity,
            presets,
            'Background Opacity / 背景透明度（←→ 预览，Enter 确认，ESC 还原）'
        );
    }

    /**
     * Show a blur slider with live preview.
     */
    private showBlurSlider() {
        const presets: { value: number; label: string }[] = [
            { value: 0,   label: '0px   (Off / 关闭)' },
            { value: 2,   label: '2px' },
            { value: 5,   label: '5px' },
            { value: 10,  label: '10px' },
            { value: 20,  label: '20px' },
            { value: 30,  label: '30px' },
            { value: 50,  label: '50px' },
            { value: 80,  label: '80px' },
            { value: 100, label: '100px (Max / 最大)' },
        ];
        this.showSliderPicker(
            'blur',
            this.blur,
            presets,
            'Background Blur / 背景模糊度（←→ 预览，Enter 确认，ESC 还原）'
        );
    }

    /**
     * Reusable slider-style picker with live preview & restore-on-cancel.
     */
    private showSliderPicker(
        configKey: 'opacity' | 'blur',
        originalValue: number,
        presets: { value: number; label: string }[],
        placeholder: string
    ) {
        // Hide the parent invoker quickPick (if any) so only the slider is on screen.
        if (this.quickPick) {
            try { this.quickPick.hide(); } catch { /* ignored */ }
        }

        const picker = window.createQuickPick<ImgItem>();
        picker.placeholder = placeholder;
        picker.matchOnDescription = false;
        picker.matchOnDetail = false;
        picker.ignoreFocusOut = false;

        const items: ImgItem[] = presets.map((p) => ({
            label: p.label,
            description: p.value === originalValue ? '$(check) current / 当前' : '',
            detail: this.renderSliderBar(p.value, presets[presets.length - 1].value),
            imageType: 0,
            path: String(p.value),
        }));
        picker.items = items;

        // Pre-select the row matching the current value (if any).
        const activeItem = items.find((it) => Number(it.path) === originalValue);
        if (activeItem) {
            picker.activeItems = [activeItem];
        }

        // Debounced live preview as the user moves the highlight.
        let previewTimer: NodeJS.Timeout | undefined;
        let committed = false;

        picker.onDidChangeActive((active) => {
            if (!active || active.length === 0) { return; }
            const v = Number(active[0].path);
            if (Number.isNaN(v)) { return; }
            if (previewTimer) { clearTimeout(previewTimer); }
            previewTimer = setTimeout(() => {
                this.applyPreview(configKey, v);
            }, 80);
        });

        picker.onDidAccept(async () => {
            const selected = picker.selectedItems[0];
            if (!selected) { return; }
            const v = Number(selected.path);
            if (Number.isNaN(v)) { return; }
            committed = true;
            if (previewTimer) { clearTimeout(previewTimer); }
            picker.hide();
            await this.setConfigValue(configKey, v, true);
        });

        picker.onDidHide(async () => {
            if (previewTimer) { clearTimeout(previewTimer); }
            // ESC / focus loss without commit: restore original look.
            if (!committed) {
                await this.applyPreview(configKey, originalValue);
            }
            picker.dispose();
        });

        picker.show();
    }

    /** Apply opacity/blur for live preview without touching settings.json. */
    private async applyPreview(configKey: 'opacity' | 'blur', value: number): Promise<void> {
        if (configKey === 'opacity') {
            this.opacity = value;
        } else {
            this.blur = value;
        }
        try {
            await this.updateDom();
        } catch (e) {
            console.error('[WallpaperStudio] preview failed:', e);
        }
    }

    /** Render a 12-cell unicode bar e.g. ████░░░░░░░░ for the slider detail row. */
    private renderSliderBar(value: number, max: number): string {
        const cells = 16;
        const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
        const filled = Math.round(ratio * cells);
        return '█'.repeat(filled) + '░'.repeat(cells - filled) + `  ${value}`;
    }

    private async showInputBox(type: InputType) {
        let placeString = '';
        let promptString = '';

        switch (type) {
            case InputType.Path:
                placeString = 'Please enter a local image path / 请输入本地壁纸路径';
                promptString = '输入图片路径：支持本地/https/json(api接口)/html(解析a标签)/在线图库（帖子地址）';
                break;
            case InputType.Opacity:
                placeString = 'Opacity ranges：0.00 - 1,current:(' + this.opacity + ')';
                promptString = '设置图片不透明度：0 - 0.8,当前值：' + this.opacity;
                break;
            case InputType.Blur:
                placeString = 'Set image blur: 0-100,current:(' + this.blur + ')';
                promptString = '设置图片模糊度：0 - 100,当前值：' + this.blur;
                break;
            case InputType.AutoRandomSettings:
                placeString = 'Auto update current:(' + this.config.get('autoInterval', 0) + ')';
                promptString = '设置自动更换间隔(秒)，0表示关闭自动定时更换 / Set interval (0 to disable)';
                break;
        }

        const option: InputBoxOptions = {
            ignoreFocusOut: true,
            password: false,
            placeHolder: placeString,
            prompt: promptString
        };

        let value = await window.showInputBox(option);
        if (!value) {
            window.showWarningMessage('Please enter configuration parameters / 请输入配置参数！');
            return false;
        }

        if (type === InputType.Path) {
            // 在线图源已移除：这里只接受本地路径。
            // 展开 ~ / ${ENV} / $ENV；无扩展名的本地路径按文件夹处理，随机取一张。
            value = expandPathVariables(value);
            const folderPicked = pickRandomFromFolder(value);
            if (folderPicked) { value = folderPicked; }
            if (!fs.existsSync(path.resolve(value))) {
                window.showWarningMessage('No access to the file or the file does not exist! / 无权限访问文件或文件不存在！');
                return false;
            }
        } else if (type === InputType.Opacity) {
            const isOpacity = parseFloat(value);
            if (isOpacity < 0 || isOpacity > 0.8 || isNaN(isOpacity)) {
                window.showWarningMessage('Opacity ranges in：0 - 0.8！');
                return false;
            }
        } else if (type === InputType.Blur) {
            const blur = parseFloat(value);
            if (blur < 0 || blur > 100 || isNaN(blur)) {
                window.showWarningMessage('Blur ranges in：0 - 100！');
                return false;
            }
        } else if (type === InputType.AutoRandomSettings) {
            const interval = parseInt(value);
            if (interval < 0 || isNaN(interval)) {
                window.showWarningMessage('Interval must be >= 0!');
                return false;
            }
        }

        if (type === InputType.Path) {
            return this.updateBackgound(value, true);
        } else if (type === InputType.Opacity) {
            await this.setConfigValue('opacity', parseFloat(value), true);
        } else if (type === InputType.Blur) {
            await this.setConfigValue('blur', parseFloat(value), true);
        } else if (type === InputType.AutoRandomSettings) {
            const interval = parseInt(value);
            if (interval > 0) {
                const hasRandomFolder = this.config.get('randomImageFolder');
                if (!hasRandomFolder) {
                    window.showWarningMessage('Please add a directory first! / 请先添加目录！');
                    return false;
                }
                await this.setConfigValue('autoInterval', interval, false);
                await this.setConfigValue('autoStatus', true, false);
                await this.autoUpdateBackground();
            } else {
                await this.setConfigValue('autoStatus', false, false);
                await this.setConfigValue('autoInterval', 0, false);
            }
        }
    }

    private async setSizeModel(value?: string) {
        if (!value) { return vsHelp.showInfo('No parameter value was obtained / 未获取到参数值'); }
        await this.setConfigValue('sizeModel', value, true);
    }

    public setImageFileType(value: number) {
        this.imageFileType = value;
    }

    public async updateBackgound(
        path?: string,
        persist: boolean = true,
        options: UpdateBackgroundOptions = {}
    ) {
        if (!path) { path = resolveCurrentImagePath(this.config.get<string>('imagePath') || ''); }
        if (!path) { return vsHelp.showInfo('Unfetched Picture Path / 未获取到图片路径'); }

        // Record into the most-recently-used list (for QuickPick reordering).
        // Keep the actual switch order for both manual and automatic changes.
        // Automatic changes must also replace the previous entry immediately,
        // otherwise the "previous" action can point at a stale background.
        this.pushRecentImage(path);

        await this.setConfigValue('imagePath', path, true, persist);
    }

    private async openFieldDialog(type: number) {
        const isFolders = type === 1 ? false : true;
        const isFiles = type === 2 ? false : true;
        const filters = type === 1 ? { 'Images and Wallpaper Engine packages': ['png', 'jpg', 'gif', 'jpeg', 'jfif', 'webp', 'bmp', 'mp4', 'webm', 'ogg', 'mov', 'pkg', 'mpkg'] } : undefined;
        const folderUris = await window.showOpenDialog({
            canSelectFolders: isFolders,
            canSelectFiles: isFiles,
            canSelectMany: type === 1,
            openLabel: 'Select folder',
            filters: filters
        });
        if (!folderUris) { return false; }
        if (type === 2) {
            const fileUri = folderUris[0];
            if (!fileUri) { return false; }
            await setSourceMode('folder');
            await getContext().globalState.update('wallpaperStudioFolderRemoved', []);
            await this.setConfigValue('randomImageFolder', fileUri.fsPath, false);
            return true;
        }
        if (type === 1) {
            await setSourceMode('file');
            const selectedPaths = folderUris.map(uri => uri.fsPath);
            for (const selectedPath of selectedPaths) {
                this.pushRecentImage(selectedPath);
            }
            const selectedPath = selectedPaths[Math.floor(Math.random() * selectedPaths.length)];
            return this.updateBackgound(selectedPath, true);
        }
        return false;
    }

    private async setConfigValue(name: string, value: any, updateDom: Boolean = true, persist: boolean = true) {
        if (name === 'imagePath') {
            const nextPath = typeof value === 'string' ? value : '';
            const previousPath = this.imgPath;
            this.imgPath = nextPath;

            // 先应用再记录：静默自动换图失败时 updateDom 会抛，此时这张图不该被
            // 记成当前背景，否则重试完三张候选后留下的"当前图"是最后一张失败的地址。
            if (updateDom) {
                try {
                    await this.updateDom();
                } catch (error) {
                    this.imgPath = previousPath;
                    throw error;
                }
            }
            await setCurrentImagePath(nextPath, { persist });
            return true;
        }
        if (persist) {
            if (name === 'opacity' || name === 'blur') {
                // 独立模式下写 globalState 的窗口/工作区记录，共用模式下回写 settings.json。
                if (name === 'opacity') {
                    await setCurrentOpacity(value, this.config);
                } else {
                    await setCurrentBlur(value, this.config);
                }
            } else {
                await this.config.update(name, value, ConfigurationTarget.Global);
            }
            this.config = getAppConfig();
        }
        switch (name) {
            case 'opacity': this.opacity = value; break;
            case 'sizeModel': this.sizeModel = value; break;
            case 'blur': this.blur = value; break;
            default: break;
        }
        if (updateDom) { await this.updateDom(); }
        return true;
    }

    public setRandUpdate(value: boolean) {
        this.randUpdate = value;
    }



    private async updateDom(uninstall: boolean = false): Promise<boolean> {
        // A4: 混合模式不再在扩展侧解析。auto 由注入 CSS 的变量 + :has() 即时适配主题，
        // 显式 multiply/lighten 直接写死。这里只把用户选择的模式传给 FileDom 生成 CSS。
        const colorThemeKind = this.config.get<string>('blendModel') ?? 'auto';

        const seq = ++PickList._updateSeq;
        const isCurrentUpdate = () => seq === PickList._updateSeq;
        const dom = new FileDom(this.config, this.imgPath, this.opacity, this.sizeModel, this.blur, colorThemeKind, isCurrentUpdate, this.silentApply);
        let result = false;

        try {
            if (uninstall) {
                await setCurrentImagePath('');
                this.imgPath = '';
                // 关背景必须把 settings.json 里的旧值一起清掉：它是新窗口/无工作区
                // 窗口的最后一层兜底，留着的话用户"关闭背景"后新开窗口又会把图捞回来，
                // 而 UI 上没有任何入口能清它。
                if (this.config.get<string>('imagePath')) {
                    await this.config.update('imagePath', '', ConfigurationTarget.Global);
                    this.config = getAppConfig();
                }
                result = await dom.clearBackground();
            } else {
                result = await dom.install();
            }

            if (seq !== PickList._updateSeq) {
                console.log('[WallpaperStudio] Ignoring stale background update result');
                return false;
            }

            if (result) {
                if (!dom.requiresReload) {
                    if (this.quickPick) {
                        this.quickPick.hide();
                    }
                    const didChangeAssets = uninstall || dom.didUpdateCss || dom.didUpdateDynamicJs;
                    PickList.fireReloadTrigger(dom.didUpdateDynamicJs ? 'js' : 'css', dom.windowCssToken);

                    setTimeout(() => {
                        if (didChangeAssets) {
                            window.setStatusBarMessage('Background updated successfully! / 背景更新成功！', 5000);
                        }
                    }, 1000);

                    return false;
                }

                if (this.quickPick) {
                    this.quickPick.placeholder = 'Reloading takes effect? / 重新加载生效？';
                    this.quickPick.items = [
                        { label: '$(check) YES', detail: '立即重新加载窗口生效', imageType: ActionType.ReloadWindow },
                        { label: '$(x) NO', detail: '稍后手动重启', imageType: ActionType.CloseMenu }
                    ];
                    this.quickPick.ignoreFocusOut = true;
                    this.quickPick.show();
                } else {
                    if (this.imageFileType === 2) {
                        const value = await window.showInformationMessage(
                            `"${this.imgPath}" | Reloading takes effect? / 重新加载生效？`,
                            'YES', 'NO'
                        );
                        if (value === 'YES') {
                            await commands.executeCommand('workbench.action.reloadWindow');
                        }
                    }
                    if (this.randUpdate) {
                        window.showInformationMessage(`背景将在1秒后自动更新！ / The background will be automatically updated in 1 second!`);
                        await new Promise((resolve) => setTimeout(resolve, 1000));
                        await commands.executeCommand('workbench.action.reloadWindow');
                    }
                }
            }
        } catch (error: any) {
            if (this.silentApply) {
                throw error;
            }
            await window.showErrorMessage(`更新失败: ${error.message}`);
        }
        return result && (dom.requiresReload || uninstall);
    }
}
