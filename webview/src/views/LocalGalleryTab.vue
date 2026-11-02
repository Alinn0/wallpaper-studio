<template>
    <div class="local-gallery">
        <!-- Source actions are kept on the playlist page, not the home page. -->
        <div class="actions-bar" :class="{ 'is-pair': state.sourceMode === 'wallpaper' }">
            <el-button v-if="state.sourceMode === 'file'" type="primary" size="small" :title="t('selectImage')" @click="onPick">
                <el-icon><Plus /></el-icon>
                <span>{{ t('selectImage') }}</span>
            </el-button>
            <el-button v-if="state.sourceMode === 'folder'" size="small" :title="t('addDirectory')" @click="onAddDir">
                <el-icon><FolderAdd /></el-icon>
                <span>{{ t('addDirectory') }}</span>
            </el-button>
            <!-- Wallpaper 模式：选择配置文件 + 重新读取，各占一半 -->
            <template v-if="state.sourceMode === 'wallpaper'">
                <el-button size="small" :title="t('selectWallpaperConfig')" @click="onSelectWallpaperConfig">
                    <el-icon><FolderOpened /></el-icon>
                    <span>{{ t('selectWallpaperConfig') }}</span>
                </el-button>
                <el-button size="small" :loading="reloadingConfig" :title="t('reloadWallpaperConfigHint')" @click="onReloadWallpaperConfig">
                    <el-icon v-if="!reloadingConfig"><Refresh /></el-icon>
                    <span>{{ t('reloadWallpaperConfig') }}</span>
                </el-button>
            </template>
        </div>

        <el-card class="grid-card wallpaper-playlist-card" shadow="never">
            <template #header>
                <div class="folder-header">
                    <span class="card-title"><el-icon><VideoCamera /></el-icon>{{ t('wallpaperList') }}</span>
                    <el-button class="back-to-top" circle size="small" :title="t('backToTop')" @click="scrollToTop">
                        <el-icon><Top /></el-icon>
                    </el-button>
                </div>
            </template>
            <div class="playlist-tools">
                <el-input v-model="wallpaperSearch" size="small" clearable :placeholder="t('searchWallpapers')" />
                <el-button size="small" type="primary" :title="t('randomWallpaper')" @click="onRandomWallpaper"><el-icon><RefreshRight /></el-icon></el-button>
            </div>
            <el-empty v-if="displayWallpapers.length === 0" :description="emptyDescription" :image-size="50" />
            <div ref="listElement" class="wallpaper-list">
                <div v-for="wallpaper in displayWallpapers" :key="wallpaper.path" class="wallpaper-row" :class="{ 'is-current': wallpaper.path === config.imagePath }" :data-pkg="sceneKey(wallpaper)" :ref="registerThumb" @click="onSelectWallpaper(wallpaper)" @mouseenter="onPkgHover(sceneKey(wallpaper))" @contextmenu.prevent="onRowContextMenu($event, wallpaper.path)">
                    <video
                        v-if="(wallpaper.mediaSource || wallpaper.preview) && isVideoPath(wallpaper.path) && !mediaFrames[wallpaper.path]"
                        :src="wallpaper.mediaSource || wallpaper.preview"
                        :data-video="wallpaper.path"
                        :ref="registerVideoThumb"
                        muted
                        playsinline
                        preload="none"
                        class="wallpaper-preview"
                        @loadedmetadata="captureVideoFrame($event, wallpaper.path)"
                        @loadeddata="captureVideoFrame($event, wallpaper.path)"
                        @canplay="captureVideoFrame($event, wallpaper.path)"
                    />
                    <img v-else-if="isVideoPath(wallpaper.path) && mediaFrames[wallpaper.path]" :src="mediaFrames[wallpaper.path]" :alt="wallpaper.title" class="wallpaper-preview" />
                    <img v-else-if="isWallpaperPkgPath(wallpaper.path) && pkgFrames[sceneKey(wallpaper)]" :src="pkgFrames[sceneKey(wallpaper)]" :alt="t('scenePreviewAlt')" class="wallpaper-preview" />
                    <div v-else-if="isWallpaperPkgPath(wallpaper.path)" class="wallpaper-preview wallpaper-preview-empty" :title="pkgErrors[sceneKey(wallpaper)] || t('scenePreviewRendering')">
                        <el-icon v-if="pkgLoading[sceneKey(wallpaper)]" class="is-loading"><Loading /></el-icon>
                        <el-icon v-else-if="pkgErrors[sceneKey(wallpaper)]"><WarningFilled /></el-icon>
                        <el-icon v-else><Picture /></el-icon>
                    </div>
                    <img v-else-if="mediaFrames[imageKey(wallpaper)]" :src="mediaFrames[imageKey(wallpaper)]" :alt="wallpaper.title" class="wallpaper-preview" />
                    <img v-else-if="wallpaper.preview" :src="wallpaper.preview" :alt="wallpaper.title" loading="lazy" class="wallpaper-preview" @load="captureImageThumb($event, imageKey(wallpaper))" />
                    <div v-else class="wallpaper-preview wallpaper-preview-empty"><el-icon><Picture /></el-icon></div>
                    <div class="wallpaper-info">
                        <strong :title="wallpaper.title">{{ wallpaper.title }}</strong>
                    </div>
                    <el-button size="small" text type="danger" :title="t('removeFromPlaylist')" @click.stop="onRemoveWallpaper(wallpaper.path)"><el-icon><Delete /></el-icon></el-button>
                </div>
            </div>
        </el-card>

        <!-- 右键菜单：在文件资源管理器中定位当前壁纸 -->
        <div
            v-if="contextMenu.visible"
            class="context-menu"
            :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
            @click.stop
            @contextmenu.prevent
        >
            <button type="button" class="context-menu-item" @click="onRevealInExplorer">
                <el-icon><FolderOpened /></el-icon>
                <span>{{ t('revealInExplorer') }}</span>
            </button>
        </div>

    </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, onUpdated, reactive, ref } from 'vue';
import { Plus, FolderAdd, FolderOpened, Picture, VideoCamera, Delete, Loading, WarningFilled, RefreshRight, Refresh, Top } from '@element-plus/icons-vue';
import { useI18n } from '../composables/useI18n';
import { useBridge } from '../composables/useBridge';
import { useScenePreview } from '../composables/useScenePreview';
import { config, state } from '../composables/useStore';
import { ActionType } from '../constants';
import { isVideoPath, isWallpaperPkgPath } from '../utils/media';
import { getThumbnail, setThumbnail } from '../composables/useThumbnailCache';

const { t } = useI18n();
const bridge = useBridge();
const scenePreview = useScenePreview();
const wallpaperSearch = ref('');
const listElement = ref<HTMLElement>();

/** 三种来源归一成同一种行结构：标题取项目名（Wallpaper 配置）或文件名（其余两种）。 */
interface GalleryItem {
    path: string;
    title: string;
    description: string;
    preview: string;
    mediaSource: string;
    sceneSource: string;
    active: boolean;
}

/**
 * 播放列表空了要区分两种情况：
 * - 配置里真没有壁纸（找不到当前用户 / 该用户列表为空）→ 用扩展推来的具体原因；
 * - 有壁纸但都被「从播放列表移除」→ 沿用通用文案。
 */
const emptyDescription = computed(() => {
    if (state.sourceMode === 'wallpaper'
        && state.wallpaperPlaylist.length === 0
        && state.wallpaperNotice) {
        return state.wallpaperNotice;
    }
    return t('wallpaperPlaylistEmpty');
});

const displayWallpapers = computed<GalleryItem[]>(() => {
    const source: GalleryItem[] = state.sourceMode === 'wallpaper'
        ? state.wallpaperPlaylist
            .filter(item => item.active)
            .map(item => ({
                path: item.path,
                title: item.title,
                description: item.description,
                preview: item.preview,
                mediaSource: item.mediaSource || '',
                sceneSource: item.sceneSource || '',
                active: true
            }))
        : (state.sourceMode === 'folder' ? state.folderImages : state.recentImages)
            .map(item => ({
                path: item.path,
                title: item.name,
                description: '',
                preview: item.display,
                mediaSource: item.display,
                sceneSource: isWallpaperPkgPath(item.path) ? item.display : '',
                active: true
            }));
    const query = wallpaperSearch.value.trim().toLowerCase();
    const filtered = query
        ? source.filter(item => `${item.title}\n${item.description}\n${item.path}`.toLowerCase().includes(query))
        : source.slice();
    // 当前壁纸永远排在第一行。
    filtered.sort((a, b) => Number(b.path === config.imagePath) - Number(a.path === config.imagePath));
    return filtered;
});

function sceneKey(wallpaper: { path: string; sceneSource?: string }): string {
    return isWallpaperPkgPath(wallpaper.path) ? (wallpaper.sceneSource || '') : '';
}

/** pkg 的 webview URI → 已渲染的首帧 dataURL（只增不减，最多几十帧 JPEG）。 */
const pkgFrames = reactive<Record<string, string>>({});
/** pkg 的 webview URI → 正在渲染 */
const pkgLoading = reactive<Record<string, boolean>>({});
/** pkg 的 webview URI → 失败原因 */
const pkgErrors = reactive<Record<string, string>>({});
const mediaFrames = reactive<Record<string, string>>({});

/**
 * 抓取视频首帧做缩略图。
 *
 * 必须缩放到缩略图的显示尺寸再编码：列表里只显示 72×40 px，而 4K 视频原始帧
 * 是 3840×2160 —— 一张 JPEG 能到 1 MB，几十张就把缓存和传输通道全堵死
 * （持久缓存有容量上限，超出的条目根本推不到面板，表现就是"有缓存还是要重新加载"）。
 */
const THUMB_WIDTH = 640;
const THUMB_HEIGHT = 360;

function fitThumbSize(width: number, height: number): { width: number; height: number } {
    if (!width || !height) { return { width: THUMB_WIDTH, height: THUMB_HEIGHT }; }
    const scale = Math.min(THUMB_WIDTH / width, THUMB_HEIGHT / height, 1);
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale))
    };
}

/** 图片缩略图缓存键：按壁纸路径，避免同一张图重复编码。 */
function imageKey(wallpaper: { path: string }): string {
    return wallpaper.path;
}

/**
 * 图片缩略图：首帧由浏览器直接绘制，同时按缩略尺寸存一份到缓存。
 * 下次（滚动回来 / 重开面板）直接用缓存的小图，不再解码原图。
 */
function captureImageThumb(event: Event, key: string) {
    if (!key || mediaFrames[key]) { return; }
    const img = event.currentTarget as HTMLImageElement | null;
    if (!img || !img.naturalWidth || !img.naturalHeight) { return; }
    const size = fitThumbSize(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) { return; }
    try {
        context.drawImage(img, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.75);
        mediaFrames[key] = dataUrl;
        setThumbnail(`image:${key}`, dataUrl);
    } catch (error) {
        // 跨域/超大图可能失败，忽略即可（原图仍会正常显示）。
        console.warn('[WallpaperStudio] Failed to capture image preview:', key, error);
    }
}

function captureVideoFrame(event: Event, key: string) {
    if (mediaFrames[key]) { return; }
    const video = event.currentTarget as HTMLVideoElement | null;
    if (!video || !video.videoWidth || !video.videoHeight) { return; }
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        void video.play().then(() => captureVideoFrame(event, key)).catch(() => undefined);
        return;
    }
    const size = fitThumbSize(video.videoWidth, video.videoHeight);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) { return; }
    try {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        mediaFrames[key] = canvas.toDataURL('image/jpeg', 0.75);
        setThumbnail(`video:${key}`, mediaFrames[key]);
    } catch (error) {
        console.warn('[WallpaperStudio] Failed to capture video preview:', key, error);
        return;
    }
    video.pause();
}

/** 首帧缓存优先：命中就直接用，不再加载视频文件。 */
function hydrateVideoThumbnails() {
    displayWallpapers.value.forEach(item => {
        if (mediaFrames[item.path]) { return; }
        if (isVideoPath(item.path)) {
            const cached = getThumbnail(`video:${item.path}`);
            if (cached) { mediaFrames[item.path] = cached; }
            return;
        }
        if (!isWallpaperPkgPath(item.path)) {
            const cached = getThumbnail(`image:${item.path}`);
            if (cached) { mediaFrames[item.path] = cached; }
        }
    });
}

function onPick()      { bridge.post({ type: 'runAction', action: ActionType.SelectPictures }); }
function onAddDir()    { bridge.post({ type: 'runAction', action: ActionType.AddDirectory }); }
function onSelectWallpaperConfig() { bridge.post({ type: 'selectWallpaperConfig' }); }

/** 重新读取当前 config.json（不重新选文件）。 */
const reloadingConfig = ref(false);
let reloadTimer: ReturnType<typeof setTimeout> | undefined;
function onReloadWallpaperConfig() {
    if (reloadingConfig.value) { return; }
    reloadingConfig.value = true;
    bridge.post({ type: 'reloadWallpaperConfig' });
    // 扩展侧读盘 + 重建列表通常几十毫秒，这里给按钮一个最短展示时间，
    // 避免闪烁；同时兜底复位，防止消息丢失后按钮永久转圈。
    if (reloadTimer) { clearTimeout(reloadTimer); }
    reloadTimer = setTimeout(() => { reloadingConfig.value = false; reloadTimer = undefined; }, 1200);
}
onUnmounted(() => { if (reloadTimer) { clearTimeout(reloadTimer); } });
function onRandomWallpaper() { bridge.post({ type: 'randomWallpaper' }); }
function onSelectWallpaper(wallpaper: { path: string }) {
    bridge.post({ type: 'useWallpaper', path: wallpaper.path });
}
function onRemoveWallpaper(path: string) { bridge.post({ type: 'removePlaylistItem', path, mode: state.sourceMode }); }

/** 列表右键菜单：目前只有「在文件资源管理器中显示」。 */
const contextMenu = reactive({ visible: false, x: 0, y: 0, path: '' });

function onRowContextMenu(event: MouseEvent, path: string) {
    if (!path) { return; }
    const MENU_WIDTH = 190;
    const MENU_HEIGHT = 40;
    contextMenu.x = Math.min(event.clientX, Math.max(0, window.innerWidth - MENU_WIDTH - 8));
    contextMenu.y = Math.min(event.clientY, Math.max(0, window.innerHeight - MENU_HEIGHT - 8));
    contextMenu.path = path;
    contextMenu.visible = true;
}

function closeContextMenu() {
    contextMenu.visible = false;
    contextMenu.path = '';
}

function onRevealInExplorer() {
    const path = contextMenu.path;
    closeContextMenu();
    if (!path) { return; }
    bridge.post({ type: 'revealInExplorer', path });
}

function onGlobalPointerDown(event: Event) {
    if (!contextMenu.visible) { return; }
    const target = event.target as HTMLElement | null;
    if (target?.closest('.context-menu')) { return; }
    closeContextMenu();
}

function onGlobalKeydown(event: KeyboardEvent) {
    if (contextMenu.visible && event.key === 'Escape') { closeContextMenu(); }
}

function scrollToTop() {
    listElement.value?.scrollTo({ top: 0, behavior: 'smooth' });
}

let videoObserver: IntersectionObserver | null = null;
const observedVideos = new WeakSet<Element>();
/** 视频缩略图：默认 preload=none，只有进入视口（或就是当前壁纸）才开始加载。 */
function registerVideoThumb(el: any) {
    const node = el as HTMLVideoElement | null;
    if (!node || !node.dataset.video || observedVideos.has(node)) { return; }
    observedVideos.add(node);
    if (node.closest('.is-current')) {
        node.preload = 'auto';
        node.load();
        return;
    }
    if (!videoObserver) {
        videoObserver = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                if (!entry.isIntersecting) { return; }
                const video = entry.target as HTMLVideoElement;
                videoObserver?.unobserve(video);
                video.preload = 'auto';
                video.load();
            });
        }, { rootMargin: '120px' });
    }
    videoObserver.observe(node);
}

function onPkgHover(display: string | undefined, priority = false) {
    if (!display || pkgFrames[display] || pkgErrors[display]) { return; }
    const cached = scenePreview.previewOf(display);
    if (cached) { pkgFrames[display] = cached; return; }
    if (pkgLoading[display]) { return; }
    pkgLoading[display] = true;
    void scenePreview.requestPreview(display, priority).then(url => {
        pkgLoading[display] = false;
        if (url) {
            pkgFrames[display] = url;
        } else {
            pkgErrors[display] = scenePreview.lastError(display) || t('scenePreviewFailed');
        }
    });
}

let observer: IntersectionObserver | null = null;
const observed = new WeakSet<Element>();

function ensureObserver(): IntersectionObserver {
    if (observer) { return observer; }
    observer = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            if (!entry.isIntersecting) { return; }
            const display = (entry.target as HTMLElement).dataset.pkg || '';
            observer?.unobserve(entry.target);
            observed.delete(entry.target);
            onPkgHover(display);
        });
    }, { rootMargin: '120px' });
    return observer;
}

/** 模板 ref：只有带 data-pkg 的缩略图（即场景包）需要提前渲染。 */
function registerThumb(el: any) {
    const node = el as HTMLElement | null;
    if (!node || !node.dataset || !node.dataset.pkg) { return; }
    if (pkgFrames[node.dataset.pkg] || pkgErrors[node.dataset.pkg]) { return; }
    if (node.closest('.is-current')) {
        onPkgHover(node.dataset.pkg, true);
        return;
    }
    if (observed.has(node)) { return; }
    observed.add(node);
    ensureObserver().observe(node);
}

/** 列表/搜索变化后把新出现的缩略图纳入观察（重复 observe 是幂等的）。 */
function scanThumbs() {
    document.querySelectorAll<HTMLElement>('.wallpaper-list [data-pkg]').forEach(node => {
        const display = node.dataset.pkg || '';
        if (!display) { return; }
        const cached = scenePreview.previewOf(display);
        if (cached) {
            if (!pkgFrames[display]) { pkgFrames[display] = cached; }
            return;
        }
        registerThumb(node);
    });
}

onMounted(() => {
    void nextTick(() => {
        hydrateVideoThumbnails();
        scanThumbs();
    });
    window.addEventListener('pointerdown', onGlobalPointerDown, true);
    window.addEventListener('keydown', onGlobalKeydown, true);
    window.addEventListener('blur', closeContextMenu);
    listElement.value?.addEventListener('scroll', closeContextMenu, { passive: true });
});

onUpdated(() => {
    hydrateVideoThumbnails();
    scanThumbs();
});

onUnmounted(() => {
    observer?.disconnect();
    observer = null;
    videoObserver?.disconnect();
    videoObserver = null;
    window.removeEventListener('pointerdown', onGlobalPointerDown, true);
    window.removeEventListener('keydown', onGlobalKeydown, true);
    window.removeEventListener('blur', closeContextMenu);
    listElement.value?.removeEventListener('scroll', closeContextMenu);
});
</script>

<style lang="scss" scoped>
.local-gallery { display: flex; flex-direction: column; gap: 12px; }
/* 三个来源按钮各占一整行 */
.actions-bar {
    display: flex;
    flex-direction: column;
    gap: 8px;
    .el-button {
        flex: 1 1 100%;
        width: 100%;
        margin-left: 0;
        justify-content: center;
    }
    /* Wallpaper 模式：选择配置 + 重新读取 并排各占一半 */
    .el-button + .el-button {
        margin-left: 0;
    }
    &.is-pair {
        flex-direction: row;
        .el-button {
            flex: 1 1 0;
            width: auto;
            min-width: 0;
        }
    }
}
.playlist-tools { display: flex; gap: 8px; margin-bottom: 8px; }
.playlist-tools .el-input { flex: 1; }
.wallpaper-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: calc(100vh - 220px);
    min-height: 200px;
    overflow-y: auto;
    padding-right: 2px;
}
.back-to-top { flex: 0 0 auto; }

.context-menu {
    position: fixed;
    z-index: 3000;
    min-width: 180px;
    padding: 4px;
    border-radius: 6px;
    background: var(--vscode-menu-background, var(--studio-input-bg));
    border: 1px solid var(--vscode-menu-border, var(--vscode-editorWidget-border));
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
}
.context-menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 10px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--vscode-menu-foreground, var(--vscode-foreground));
    font: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
    &:hover { background: var(--vscode-menu-selectionBackground, rgba(56, 189, 248, 0.28)); }
}
.wallpaper-row { display: flex; align-items: center; gap: 8px; padding: 6px; border-radius: 6px; background: var(--studio-input-bg); cursor: default; border: 1px solid transparent; }
.wallpaper-row:hover { border-color: #3b82f6; box-shadow: 0 0 0 1px rgba(59, 130, 246, 0.35); }
.wallpaper-row.is-current { outline: 1px solid var(--studio-accent); }
.wallpaper-preview { width: 72px; height: 40px; object-fit: cover; border-radius: 4px; background: #000; flex: 0 0 auto; }
.wallpaper-preview-empty { display: flex; align-items: center; justify-content: center; color: var(--vscode-descriptionForeground); }
.wallpaper-info { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
.wallpaper-info strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }


.folder-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
}

</style>