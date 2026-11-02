<template>
    <div class="studio" :data-theme="theme" :data-ui-theme="uiTheme">
        <header class="studio-header">
            <div class="brand">
                <span class="brand-icon">
                    <img v-if="brand.logo" :src="brand.logo" :alt="brand.name || t('logoAlt')" />
                    <el-icon v-else><Picture /></el-icon>
                </span>
                <span class="brand-title">{{ brand.name || t('appTitle') }}</span>
            </div>
            <div class="header-actions">
                <el-dropdown trigger="click" :popper-class="dropdownPopperClass" @command="onUiThemeChange">
                    <el-button text size="small" :title="t('theme')">
                        <el-icon><Brush /></el-icon>
                        <span class="theme-label">{{ uiThemeLabel }}</span>
                    </el-button>
                    <template #dropdown>
                        <el-dropdown-menu>
                            <el-dropdown-item command="default" :disabled="uiTheme === 'default'">
                                {{ t('themeDefault') }}
                            </el-dropdown-item>
                            <el-dropdown-item command="overwatch" :disabled="uiTheme === 'overwatch'">
                                {{ t('themeOverwatch') }}
                            </el-dropdown-item>
                        </el-dropdown-menu>
                    </template>
                </el-dropdown>
                <el-dropdown trigger="click" :popper-class="dropdownPopperClass" @command="onLangChange">
                    <el-button text size="small" :title="t('language')">
                        <el-icon><Place /></el-icon>
                        <span class="lang-label">{{ locale === 'zh' ? '中' : 'EN' }}</span>
                    </el-button>
                    <template #dropdown>
                        <el-dropdown-menu>
                            <el-dropdown-item command="en" :disabled="locale === 'en'">
                                {{ t('langEnglish') }}
                            </el-dropdown-item>
                            <el-dropdown-item command="zh" :disabled="locale === 'zh'">
                                {{ t('langChinese') }}
                            </el-dropdown-item>
                        </el-dropdown-menu>
                    </template>
                </el-dropdown>
                <el-button text circle size="small" :title="t('refresh')" @click="onRefresh">
                    <el-icon><Refresh /></el-icon>
                </el-button>
            </div>
        </header>

        <el-tabs
            v-model="active"
            class="studio-tabs"
            stretch
        >
            <el-tab-pane
                v-for="tab in tabs"
                :key="tab.key"
                :name="tab.key"
            >
                <template #label>
                    <span class="tab-label">
                        <el-icon><component :is="tab.icon" /></el-icon>
                        <span>{{ tab.label }}</span>
                    </span>
                </template>
            </el-tab-pane>
        </el-tabs>

        <main class="studio-body">
            <!-- 首次激活时才挂载，之后保持挂载（v-show）以保留各 Tab 状态 -->
            <template v-for="tab in tabs" :key="tab.key">
                <component
                    :is="views[tab.key]"
                    v-if="visited.has(tab.key)"
                    v-show="active === tab.key"
                    class="studio-panel"
                />
            </template>
        </main>

        <!-- 右下角轻量提示（跨模式切换失败、没有上一张等） -->
        <transition-group name="toast" tag="div" class="toast-stack">
            <div
                v-for="item in toasts"
                :key="item.id"
                class="toast"
                :class="'is-' + item.level"
                role="status"
            >
                <el-icon>
                    <WarningFilled v-if="item.level !== 'info'" />
                    <InfoFilled v-else />
                </el-icon>
                <span class="toast-text">{{ item.text }}</span>
            </div>
        </transition-group>
    </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted, watch } from 'vue';
import { Picture, Refresh, House, Folder, Setting, Place, Brush, WarningFilled, InfoFilled } from '@element-plus/icons-vue';
import HomeTab from './views/HomeTab.vue';
import LocalGalleryTab from './views/LocalGalleryTab.vue';
import AdvancedTab from './views/AdvancedTab.vue';
import { useTheme } from './composables/useTheme';
import { useBridge } from './composables/useBridge';
import { useI18n, setLocale, type Locale } from './composables/useI18n';
import { applyState, brand } from './composables/useStore';
import { clearThumbnailCache, hydrateThumbnails, setThumbnailReporter } from './composables/useThumbnailCache';
import { useScenePreview } from './composables/useScenePreview';

const { t, locale } = useI18n();
const bridge = useBridge();
const theme = useTheme();
type StudioUiTheme = 'default' | 'overwatch';

/**
 * 界面偏好存放在 VS Code webview state（acquireVsCodeApi().getState/setState），
 * 不再使用 localStorage。首次运行时把旧 localStorage 中的值迁移过来。
 */
interface UiPrefs {
    uiTheme?: StudioUiTheme;
    locale?: Locale;
    activeTab?: string;
}
const LEGACY_KEYS: Record<keyof UiPrefs, string> = {
    uiTheme: 'bgc.uiTheme',
    locale: 'bgc.locale',
    activeTab: 'bgc.activeTab'
};

function loadPrefs(): UiPrefs {
    const prefs: UiPrefs = { ...bridge.getState<UiPrefs>() };
    const migrated: UiPrefs = {};
    try {
        for (const [field, legacyKey] of Object.entries(LEGACY_KEYS) as Array<[keyof UiPrefs, string]>) {
            const legacy = localStorage.getItem(legacyKey);
            if (legacy === null) { continue; }
            if (prefs[field] === undefined) { (migrated as any)[field] = legacy; }
            localStorage.removeItem(legacyKey);
        }
    } catch { /* localStorage 不可用时忽略 */ }
    if (Object.keys(migrated).length) {
        Object.assign(prefs, migrated);
        bridge.patchState(migrated);
    }
    return prefs;
}

const prefs = loadPrefs();

const uiTheme = ref<StudioUiTheme>(prefs.uiTheme === 'overwatch' ? 'overwatch' : 'default');
const uiThemeLabel = computed(() => uiTheme.value === 'overwatch' ? t('themeOverwatchShort') : t('themeDefaultShort'));
const dropdownPopperClass = computed(() => `studio-dropdown studio-dropdown--${uiTheme.value}`);

function onUiThemeChange(value: StudioUiTheme) {
    uiTheme.value = value === 'overwatch' ? 'overwatch' : 'default';
    bridge.patchState({ uiTheme: uiTheme.value });
}

const userLocaleOverride = ref<Locale | null>(
    prefs.locale === 'zh' || prefs.locale === 'en' ? prefs.locale : null
);
if (userLocaleOverride.value) { setLocale(userLocaleOverride.value); }

function onLangChange(value: Locale) {
    userLocaleOverride.value = value;
    setLocale(value);
    bridge.patchState({ locale: value });
    bridge.post({ type: 'setGlobalState', key: 'wallpaperStudioLocale', value });
}

const tabs = computed(() => [
    { key: 'home',       label: t('tabHome'),       icon: House },
    { key: 'local',      label: t('tabLocal'),      icon: Folder },
    { key: 'advanced',   label: t('tabAdvanced'),   icon: Setting }
]);

const views: Record<string, any> = {
    home: HomeTab,
    local: LocalGalleryTab,
    advanced: AdvancedTab
};

/**
 * 面板固定从「首页」打开。
 *
 * 之前会恢复上次停留的页签，但用户希望每次打开都先看到首页
 * （当前壁纸、切换模式、全局设置都在那里），因此不再读取 `activeTab`。
 */
const initialTab = 'home';
const active = ref(initialTab);
const visited = reactive(new Set<string>([initialTab]));

watch(active, (value) => {
    visited.add(value);
    if (value === 'local') { bridge.post({ type: 'loadGallery' }); }
});

bridge.on('state', (data: any) => {
    const payload = data?.data ?? {};
    if (payload.locale && !userLocaleOverride.value) { setLocale(payload.locale); }
    applyState(payload);
});

bridge.on('navigate', (data: any) => {
    const t = data?.tab;
    // Map legacy tab names from extension to new keys
    const map: Record<string, string> = { gallery: 'local', menu: 'home' };
    const target = map[t] ?? t;
    if (target && views[target]) { active.value = target; }
});

// 扩展端「清除所有缓存与配置」之后要求面板也把本地缓存丢弃。
bridge.on('purgeLocalCache', () => {
    clearThumbnailCache();
    const scenePreview = useScenePreview();
    scenePreview.invalidate();
    scenePreview.releaseFrame();
    userLocaleOverride.value = null;
    uiTheme.value = 'default';
    active.value = 'home';
    try {
        localStorage.clear();
        bridge.patchState({ uiTheme: 'default', locale: undefined, activeTab: 'home' });
    } catch { /* localStorage 不可用时忽略 */ }
});

function onRefresh() {
    bridge.post({ type: 'ready' });
}

interface ToastItem { id: number; text: string; level: 'info' | 'warning' | 'error'; }
const toasts = ref<ToastItem[]>([]);
let toastSeq = 0;
const toastTimers = new Map<number, ReturnType<typeof setTimeout>>();

/** 右下角提示：最多同时 3 条，3 秒后自动消失。 */
function pushToast(text: string, level: ToastItem['level'] = 'info') {
    if (!text) { return; }
    const id = ++toastSeq;
    toasts.value = [...toasts.value, { id, text, level }].slice(-3);
    toastTimers.set(id, setTimeout(() => {
        toastTimers.delete(id);
        toasts.value = toasts.value.filter(item => item.id !== id);
    }, 3000));
}
onUnmounted(() => {
    toastTimers.forEach(timer => clearTimeout(timer));
    toastTimers.clear();
});

bridge.on('toast', (data: any) => {
    pushToast(String(data?.text || ''), (data?.level as ToastItem['level']) || 'info');
});

// 缩略图跨重启复用：扩展侧持久化的首帧直接填充面板缓存，不再重新渲染。
setThumbnailReporter((key, value) => bridge.post({ type: 'cacheThumbnail', key, value }));
bridge.on('thumbnails', (data: any) => {
    hydrateThumbnails(data?.data as Record<string, string> | undefined);
});

onMounted(() => {
    bridge.post({ type: 'ready' });
});
</script>

<style lang="scss" scoped>
.studio {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    overflow: hidden;
    background: var(--vscode-sideBar-background);
    background-image:
        var(--studio-page-grad-1),
        var(--studio-page-grad-2);
    background-attachment: local;
    position: relative;
}

.studio::before {
    content: '';
    position: absolute;
    inset: 0;
    pointer-events: none;
    background:
        radial-gradient(120% 60% at 50% -10%, rgba(56,189,248,0.12) 0%, transparent 55%);
    z-index: 0;
}

.studio[data-ui-theme='overwatch'] {
    --studio-accent:        #f99e1a;
    --studio-accent-2:      #27b6df;
    --studio-accent-soft:   rgba(249, 158, 26, 0.18);
    --studio-card-bg:       #eff6fc;
    --studio-card-border:   1px solid rgba(33, 52, 72, 0.18);
    --studio-card-shadow:   0 1px 0 rgba(255,255,255,0.95) inset,
                            0 8px 20px rgba(26, 42, 60, 0.18);
    --studio-card-glow:     0 0 0 1px rgba(249, 158, 26, 0.18),
                            0 10px 24px rgba(26, 42, 60, 0.20);
    --studio-divider:       1px solid rgba(33, 52, 72, 0.14);
    --studio-input-bg:      #ffffff;
    --studio-input-border:  1px solid rgba(33, 52, 72, 0.22);
    --studio-btn-grad:      linear-gradient(135deg, #ffb02e 0%, #f36c21 100%);
    --studio-btn-glow:      0 5px 14px rgba(249, 158, 26, 0.26);
    --studio-btn-soft:        #ffffff;
    --studio-btn-soft-hover:  #e6f2fb;
    --studio-btn-soft-border: rgba(45, 77, 108, 0.22);
    --studio-page-grad-1:   linear-gradient(180deg, rgba(255,255,255,0.96), rgba(226,235,245,0.92));
    --studio-page-grad-2:   radial-gradient(75% 46% at 100% 0%, rgba(39,182,223,0.18) 0%, transparent 62%);
    --bgc-bg:               #e6eef6;
    --bgc-fg:               #1f2d3c;
    --bgc-fg-muted:         #3f5266;
    --vscode-foreground:    #1f2d3c;
    --vscode-descriptionForeground: #3f5266;
    --vscode-input-foreground: #1f2d3c;
    --vscode-input-placeholderForeground: #637386;
    --vscode-editorWidget-background: #eff6fc;
    --vscode-menu-background: #ffffff;
    --vscode-editor-background: #e9f3fb;
    color: #1f2d3c;
    background: #e6eef6;
}

.studio[data-ui-theme='overwatch'] {
    --el-text-color-primary:   #1f2d3c;
    --el-text-color-regular:   #26394d;
    --el-text-color-secondary: #3f5266;
    --el-text-color-placeholder: #637386;
    --el-text-color-disabled:  #7b8795;
    --el-bg-color:             #eff6fc;
    --el-bg-color-overlay:     #ffffff;
    --el-fill-color-blank:     #e9f3fb;
}

.studio[data-ui-theme='overwatch']::before {
    background:
        linear-gradient(90deg, rgba(249,158,26,0.18) 0 3px, transparent 3px 100%),
        radial-gradient(80% 40% at 100% 0%, rgba(39,182,223,0.20) 0%, transparent 60%);
}

.studio > * { position: relative; z-index: 1; }

.studio-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px 6px;
    flex-shrink: 0;
}

.brand {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
}

.studio[data-ui-theme='overwatch'] .studio-header {
    padding: 10px 12px 8px;
    background: #1f2d3c;
    border-bottom: 2px solid #f99e1a;
    box-shadow: 0 6px 18px rgba(20, 38, 62, 0.18);
}

.studio[data-ui-theme='overwatch'] .brand-title {
    background: none;
    -webkit-text-fill-color: #f4faff;
    color: #f4faff;
    text-transform: uppercase;
    letter-spacing: 0;
}

.studio[data-ui-theme='overwatch'] .brand-icon {
    border-radius: 5px;
    background: linear-gradient(135deg, #ffb02e, #f36c21);
    box-shadow: 0 0 0 1px rgba(255,255,255,0.22), 0 6px 14px rgba(249,158,26,0.30);
}

.brand-icon {
    font-size: 18px;
    color: #fff;
    width: 26px;
    height: 26px;
    border-radius: 8px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--studio-btn-grad);
    box-shadow: var(--studio-btn-glow);
    overflow: hidden;
    img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
    }
}

.brand-title {
    font-size: 13px;
    font-weight: 700;
    background: linear-gradient(135deg, var(--studio-accent), var(--studio-accent-2));
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    letter-spacing: 0.2px;
}

.header-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
}

.lang-label {
    font-size: 11px;
    margin-left: 2px;
    color: var(--vscode-foreground);
}

.theme-label,
.lang-label {
    max-width: 54px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.studio[data-ui-theme='overwatch'] .header-actions :deep(.el-button.is-text) {
    color: #f4faff !important;
    border-radius: 5px;
    text-transform: uppercase;
}

.studio[data-ui-theme='overwatch'] .header-actions :deep(.el-button.is-text span),
.studio[data-ui-theme='overwatch'] .header-actions :deep(.el-button.is-text .el-icon) {
    color: #f4faff !important;
}

.studio[data-ui-theme='overwatch'] .header-actions :deep(.el-button.is-text:hover) {
    background: rgba(255,255,255,0.14);
    color: #ffb02e !important;
}

.studio[data-ui-theme='overwatch'] .header-actions :deep(.el-button.is-text:hover span),
.studio[data-ui-theme='overwatch'] .header-actions :deep(.el-button.is-text:hover .el-icon) {
    color: #ffb02e !important;
}

.studio-tabs {
    flex-shrink: 0;
    padding: 0 8px;
}

.studio[data-ui-theme='overwatch'] .studio-tabs {
    padding: 7px 8px 0;
    background: rgba(246, 249, 252, 0.86);
    border-bottom: 1px solid rgba(33, 52, 72, 0.10);
}

.studio-tabs :deep(.el-tabs__header) { margin: 0; }
.studio-tabs :deep(.el-tabs__nav-wrap)::after { background: transparent; }
.studio-tabs :deep(.el-tabs__item) {
    padding: 0 8px;
    height: 32px;
    line-height: 32px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    &.is-active {
        color: var(--el-color-primary);
        font-weight: 600;
    }
}

.studio[data-ui-theme='overwatch'] .studio-tabs :deep(.el-tabs__item) {
    height: 32px;
    line-height: 32px;
    color: #526273;
    text-transform: uppercase;
    font-weight: 700;
    border-radius: 5px 5px 0 0;
}

.studio[data-ui-theme='overwatch'] .studio-tabs :deep(.el-tabs__item.is-active) {
    color: #172232;
    background: #ffffff;
}

.studio[data-ui-theme='overwatch'] .studio-tabs :deep(.el-tabs__active-bar) {
    height: 3px;
    background: linear-gradient(90deg, #ffb02e, #f36c21) !important;
    box-shadow: 0 0 12px rgba(249, 158, 26, 0.65);
}
.studio-tabs :deep(.el-tabs__active-bar) {
    height: 2px;
    background: var(--el-color-primary);
}

.tab-label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    .el-icon { font-size: 13px; }
}

.studio-body {
    flex: 1 1 auto;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 8px 10px 10px;
}

.studio-panel {
    min-height: 100%;
}

.studio[data-ui-theme='overwatch'] :deep(.el-card) {
    border-radius: 7px !important;
    clip-path: none;
}

.studio[data-ui-theme='overwatch'] :deep(.el-card__header) {
    background:
        linear-gradient(90deg, rgba(249,158,26,0.14), transparent 62%),
        #f4faff;
}

.studio[data-ui-theme='overwatch'] :deep(.card-title),
.studio[data-ui-theme='overwatch'] :deep(.row-label),
.studio[data-ui-theme='overwatch'] :deep(.slider-label),
.studio[data-ui-theme='overwatch'] :deep(.slider-value),
.studio[data-ui-theme='overwatch'] :deep(.meta-label),
.studio[data-ui-theme='overwatch'] :deep(.meta-path),
.studio[data-ui-theme='overwatch'] :deep(.folder-path),
.studio[data-ui-theme='overwatch'] :deep(.apply-hint),

.studio[data-ui-theme='overwatch'] :deep(.el-empty__description),
.studio[data-ui-theme='overwatch'] :deep(.folder-more) {
    color: #3f5266 !important;
}

.studio[data-ui-theme='overwatch'] :deep(.el-dropdown-menu__item) {
    color: #1f2d3c !important;
}

.studio[data-ui-theme='overwatch'] :deep(.el-dropdown-menu__item:not(.is-disabled):hover) {
    color: #f36c21 !important;
    background: rgba(249, 158, 26, 0.14) !important;
}

.studio[data-ui-theme='overwatch'] :deep(.el-button:not(.is-circle)) {
    border-radius: 6px !important;
    clip-path: none;
    text-transform: uppercase;
    font-weight: 700;
}

.studio[data-ui-theme='overwatch'] :deep(.el-button--primary) {
    color: #1d2633 !important;
}

.studio[data-ui-theme='overwatch'] :deep(.thumb) {
    border-radius: 6px;
    clip-path: none;
}

:global(.studio-dropdown--overwatch .el-dropdown-menu) {
    background: #ffffff !important;
    border: 1px solid rgba(33, 52, 72, 0.18) !important;
    box-shadow: 0 10px 24px rgba(26, 42, 60, 0.22) !important;
}

:global(.studio-dropdown--overwatch .el-dropdown-menu__item) {
    color: #1f2d3c !important;
}

:global(.studio-dropdown--overwatch .el-dropdown-menu__item.is-disabled) {
    color: #7b8795 !important;
}

:global(.studio-dropdown--overwatch .el-dropdown-menu__item:not(.is-disabled):hover) {
    color: #f36c21 !important;
    background: rgba(249, 158, 26, 0.14) !important;
}

/* 右下角提示 */
.toast-stack {
    position: fixed;
    right: 12px;
    bottom: 12px;
    z-index: 4000;
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: flex-end;
    pointer-events: none;
}
.toast {
    display: flex;
    align-items: center;
    gap: 6px;
    max-width: 280px;
    padding: 7px 11px;
    border-radius: 6px;
    font-size: 12px;
    line-height: 1.4;
    color: var(--vscode-foreground);
    background: var(--vscode-editorWidget-background, rgba(30, 34, 42, 0.96));
    border: 1px solid var(--vscode-editorWidget-border, rgba(125, 175, 230, 0.28));
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
    &.is-warning { border-color: #d9a441; }
    &.is-error { border-color: var(--vscode-errorForeground, #f14c4c); }
    &.is-warning .el-icon { color: #d9a441; }
    &.is-error .el-icon { color: var(--vscode-errorForeground, #f14c4c); }
    &.is-info .el-icon { color: var(--studio-accent); }
}
.toast-text { overflow: hidden; text-overflow: ellipsis; }

.toast-enter-active,
.toast-leave-active { transition: opacity 0.18s ease, transform 0.18s ease; }
.toast-enter-from,
.toast-leave-to { opacity: 0; transform: translateY(6px); }
</style>
