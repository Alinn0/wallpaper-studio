<template>
    <div class="home-tab">
        <!-- Preview card -->
        <el-card class="preview-card" shadow="never">
            <div class="preview-frame" :class="{ 'is-empty': !displayUrl }">
                <img
                    v-if="previewThumbnail"
                    :src="previewThumbnail"
                    :alt="t('previewAlt')"
                />
                <video
                    v-else-if="displayUrl && isVideo && !isThumbnailGenerating"
                    class="thumbnail-source"
                    :src="displayUrl"
                    muted
                    playsinline
                    preload="auto"
                    @loadeddata="captureVideoThumb"
                    @canplay="captureVideoThumb"
                />
                <img
                    v-else-if="displayUrl && !isWallpaperPkg"
                    class="thumbnail-source"
                    :src="displayUrl"
                    alt=""
                    @load="captureImageThumb"
                />
                <div v-else class="preview-empty">
                    <el-icon :size="32"><Picture /></el-icon>
                    <span>{{ emptyText }}</span>
                </div>
            </div>
            <div class="preview-meta">
                <span class="meta-label">{{ t('currentBackground') }}</span>
                <span class="meta-path" :title="displayPathTitle">
                    {{ displayPath || t('notSet') }}
                </span>
            </div>
            <div class="preview-actions">
                <el-button size="small" :title="t('previousWallpaper')" @click="onPrevious">
                    <el-icon><ArrowLeft /></el-icon>
                </el-button>
                <el-button size="small" type="primary" :title="t('randomWallpaper')" @click="onRandom">
                    <el-icon><RefreshRight /></el-icon>
                </el-button>
            </div>
        </el-card>

        <el-card shadow="never" class="section-card">
            <template #header>
                <span class="card-title">{{ t('sourceMode') }}</span>
            </template>
            <el-select v-model="selectedMode" class="mode-select" size="small" @change="onModeChange">
                <el-option value="file" :label="t('sourceModeFile')" />
                <el-option value="folder" :label="t('sourceModeFolder')" />
                <el-option value="wallpaper" :label="t('sourceModeWallpaper')" />
            </el-select>
        </el-card>

        <el-card shadow="never" class="section-card">
            <template #header>
                <span class="card-title">{{ t('wallpaperSettings') }}</span>
            </template>
            <div class="global-setting">
                <label>{{ t('opacity') }}</label>
                <el-slider v-model="config.opacity" :min="0" :max="0.8" :step="0.01" @change="setGlobalConfig('opacity', config.opacity)" />
            </div>
            <div class="global-setting">
                <label>{{ t('blur') }}</label>
                <el-slider v-model="config.blur" :min="0" :max="100" :step="1" @change="setGlobalConfig('blur', config.blur)" />
            </div>
            <el-collapse v-model="settingsOpen">
                <el-collapse-item name="wallpaper-properties">
                    <template #title><el-icon><Setting /></el-icon>{{ t('wallpaperPropertySettings') }}</template>
                    <div v-if="properties.length" class="property-list">
                        <template v-for="property in projectProperties" :key="property.key">
                            <div v-if="property.type === 'group'" class="property-group">{{ property.text }}</div>
                            <div v-else-if="property.type === 'header'" class="property-header">{{ property.text }}</div>
                            <div v-else-if="property.type === 'label'" class="property-label">{{ property.text }}</div>
                            <div v-else class="global-setting">
                                <label :title="property.text">{{ property.text }}</label>
                                <el-switch v-if="property.type === 'bool'" v-model="property.value" @change="updateWallpaperProperty(property.key, property.value)" />
                                <el-color-picker
                                    v-else-if="property.type === 'color'"
                                    :model-value="colorHex(property)"
                                    size="small"
                                    @change="(value: string | null) => updateColorProperty(property, value)"
                                />
                                <el-select v-else-if="property.type === 'combo'" v-model="property.value" size="small" @change="updateWallpaperProperty(property.key, property.value)">
                                    <el-option v-for="option in property.options || []" :key="option.value" :label="option.label" :value="option.value" />
                                </el-select>
                                <el-slider
                                    v-else-if="property.type === 'slider'"
                                    v-model="property.value"
                                    :min="sliderMin(property)"
                                    :max="sliderMax(property)"
                                    :step="sliderStep(property)"
                                    :show-tooltip="true"
                                    @input="onPropertySliderInput(property)"
                                />
                                <el-input v-else v-model="property.value" size="small" @change="updateWallpaperProperty(property.key, property.value)" />
                            </div>
                        </template>
                    </div>
                    <div v-if="config.imagePath" class="xy-settings">
                        <div class="xy-row">
                            <label :title="t('cameraPanX')">{{ t('cameraPanX') }}</label>
                            <el-slider v-model="cameraPanX" :min="PAN_MIN" :max="PAN_MAX" :step="1" :show-tooltip="true" @input="onViewOffsetInput" />
                        </div>
                        <div class="xy-row">
                            <label :title="t('cameraPanY')">{{ t('cameraPanY') }}</label>
                            <el-slider v-model="cameraPanY" :min="PAN_MIN" :max="PAN_MAX" :step="1" :show-tooltip="true" @input="onViewOffsetInput" />
                        </div>
                        <div class="xy-row xy-reset">
                            <el-button size="small" text @click="resetViewOffset">{{ t('resetViewOffset') }}</el-button>
                        </div>
                    </div>
                    <el-empty v-if="!projectProperties.length && !config.imagePath" :description="t('notSet')" :image-size="40" />
                </el-collapse-item>
            </el-collapse>
        </el-card>

    </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Picture, ArrowLeft, RefreshRight, Setting } from '@element-plus/icons-vue';
import { useI18n } from '../composables/useI18n';
import { useBridge } from '../composables/useBridge';
import { useScenePreview } from '../composables/useScenePreview';
import { getThumbnail, setThumbnail, thumbnailRevision } from '../composables/useThumbnailCache';
import { config, state, type WallpaperProperty } from '../composables/useStore';
import { isVideoPath, isWallpaperPkgPath } from '../utils/media';

const { t } = useI18n();
const bridge = useBridge();
const scenePreview = useScenePreview();
const settingsOpen = ref<string[]>([]);
/**
 * 相机视角（只有平移，没有缩放）。
 *
 * 两个滑块都是「百分比」语义、默认 100：
 *   0 = 贴左/上，100 = 居中，200 = 贴右/下。
 *
 * 平移需要画面比视口大才有余量，所以渲染侧会按平移量自动放大画面
 * （见 resources/wallpaper-scene.js 的 applyViewOffset()）。
 * 这样默认 100/100 时仍是原样铺满，不会莫名放大。
 */
const PAN_MIN = 0;
const PAN_MAX = 200;
const PAN_DEFAULT = 100;
const cameraPanX = ref(PAN_DEFAULT);
const cameraPanY = ref(PAN_DEFAULT);
let viewOffsetTimer: ReturnType<typeof setTimeout> | undefined;
/** 用户正在拖拽 XY 时，扩展回推的旧值不能把滑块拽回去。 */
let xyDirtyUntil = 0;
const selectedMode = computed({
    get: () => state.sourceMode,
    set: (value: 'file' | 'folder' | 'wallpaper') => { state.sourceMode = value; }
});

// 只用扩展侧给出的本地路径。在线地址一律不直连，避免每次刷新都回源云存储。
const displayUrl = computed(() => config.imagePathDisplay || '');

const isWallpaperPkg = computed(() => isWallpaperPkgPath(config.imagePath));
const isVideo = computed(() => isVideoPath(config.imagePath));
const samePath = (a: string, b: string) =>
    !!a && !!b && a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();

const currentWallpaper = computed(() => {
    if (state.sourceMode === 'wallpaper') {
        return state.wallpaperPlaylist.find(item => item.active && samePath(item.path, config.imagePath)) || null;
    }
    const source = state.sourceMode === 'folder' ? state.folderImages : state.recentImages;
    const item = source.find(entry => samePath(entry.path, config.imagePath));
    return item ? { path: item.path, title: item.name, properties: item.properties || [] } : null;
});

/**
 * 首页展示的配置项：优先用扩展推来的「当前背景」属性（三种来源都走同一条解析），
 * 只有在它为空时才退回列表里对应项的属性。
 */
const properties = computed<WallpaperProperty[]>(() => {
    const fromConfig = config.imageProperties || [];
    if (fromConfig.length) { return fromConfig; }
    return currentWallpaper.value?.properties || [];
});

/** 视角项由下面的 X/Y 区块专门渲染，不再混进项目属性列表。 */
const VIEW_PROPERTY_KEYS = new Set(['wallpaperstudio_pan_x', 'wallpaperstudio_pan_y']);

const projectProperties = computed<WallpaperProperty[]>(() =>
    properties.value.filter(property => !VIEW_PROPERTY_KEYS.has(property.key))
);

/** 当前壁纸的标识：用它判断"换壁纸了"，比路径比较更稳（大小写/斜杠差异）。 */
const currentKey = computed(() => (config.imagePath || '').replace(/\\/g, '/').toLowerCase());

function readViewValue(key: string, min: number, max: number, fallback: number): number {
    const value = properties.value.find(property => property.key === key)?.value;
    const number = Number(value);
    if (!Number.isFinite(number)) { return fallback; }
    return Math.min(max, Math.max(min, number));
}

/** 超出可显示范围时贴到边界，而不是回退到上一次的值。 */
function clampRange(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) { return min; }
    return Math.min(max, Math.max(min, value));
}

function syncViewOffsets() {
    if (Date.now() < xyDirtyUntil) { return; }
    cameraPanX.value = readViewValue('wallpaperstudio_pan_x', PAN_MIN, PAN_MAX, PAN_DEFAULT);
    cameraPanY.value = readViewValue('wallpaperstudio_pan_y', PAN_MIN, PAN_MAX, PAN_DEFAULT);
}

watch(currentKey, () => {
    // 换壁纸（手动 / 随机 / 自动轮播）时立刻接受新壁纸的 XY 记录。
    xyDirtyUntil = 0;
    syncViewOffsets();
});
watch(properties, syncViewOffsets);
syncViewOffsets();

const emptyText = computed(() => {
    if (!config.imagePath) { return t('none'); }
    return t('scenePreviewRendering');
});

const isThumbnailGenerating = ref(false);

/** 首页和列表共用同一组缓存键与缩略图尺寸。 */
const THUMB_WIDTH = 640;
const THUMB_HEIGHT = 360;
function fitThumbSize(width: number, height: number): { width: number; height: number } {
    if (!width || !height) { return { width: THUMB_WIDTH, height: THUMB_HEIGHT }; }
    const scale = Math.min(THUMB_WIDTH / width, THUMB_HEIGHT / height, 1);
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function captureImageThumb(event: Event) {
    const img = event.currentTarget as HTMLImageElement | null;
    const key = config.imagePath;
    if (!img || !key || !img.naturalWidth || !img.naturalHeight || getThumbnail(`image:${key}`)) { return; }
    const size = fitThumbSize(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) { return; }
    try {
        setThumbnail(`image:${key}`, canvasToThumbnail(context, img, canvas));
    } catch (error) {
        console.warn('[WallpaperStudio] Failed to capture home image thumbnail:', key, error);
    }
}

function captureVideoThumb(event: Event) {
    const video = event.currentTarget as HTMLVideoElement | null;
    const key = config.imagePath;
    if (!video || !key || !video.videoWidth || !video.videoHeight || getThumbnail(`video:${key}`)) { return; }
    const size = fitThumbSize(video.videoWidth, video.videoHeight);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) { return; }
    try {
        setThumbnail(`video:${key}`, canvasToThumbnail(context, video, canvas));
        video.pause();
    } catch (error) {
        console.warn('[WallpaperStudio] Failed to capture home video thumbnail:', key, error);
    }
}

function canvasToThumbnail(context: CanvasRenderingContext2D, source: CanvasImageSource, canvas: HTMLCanvasElement): string {
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.8);
}

/** 首页优先显示缓存；缓存未命中时只生成一次缩略图，不显示实时媒体。 */
const previewThumbnail = computed(() => {
    void thumbnailRevision.value;
    const path = config.imagePath;
    if (!path) { return ''; }
    if (isWallpaperPkg.value) {
        // The list stores scene frames by sceneSource (normally the package URI).
        // Keep the raw path fallback for caches created before URI normalization.
        return getThumbnail(`scene:${config.imagePathDisplay}`)
            || getThumbnail(`scene:${path}`)
            || '';
    }
    return getThumbnail(`${isVideoPath(path) ? 'video' : 'image'}:${path}`) || '';
});

watch([currentKey, previewThumbnail], () => {
    if (!isWallpaperPkg.value || !displayUrl.value || previewThumbnail.value) { return; }
    isThumbnailGenerating.value = true;
    void scenePreview.requestPreview(displayUrl.value, true, config.sceneRender).finally(() => {
        isThumbnailGenerating.value = false;
    });
}, { immediate: true });

const shortPath = computed(() => {
    const p = config.imagePath || '';
    if (!p) { return ''; }
    return p.length > 40 ? '…' + p.slice(-39) : p;
});
const displayPath = computed(() => state.sourceMode === 'wallpaper'
    ? (config.imagePathLabel || shortPath.value)
    : shortPath.value);
const displayPathTitle = computed(() => state.sourceMode === 'wallpaper'
    ? (config.imagePathLabel || config.imagePath)
    : config.imagePath);

function onModeChange(mode: 'file' | 'folder' | 'wallpaper') {
    bridge.post({ type: 'setSourceMode', mode });
}
function onPrevious() { bridge.post({ type: 'previousWallpaper' }); }
function onRandom() { bridge.post({ type: 'randomWallpaper' }); }
function setGlobalConfig(key: 'opacity' | 'blur', value: number) {
    bridge.post({ type: 'setConfig', key, value });
}
function updateWallpaperProperty(key: string, value: unknown) {
    if (!config.imagePath) { return; }
    bridge.post({ type: 'setWallpaperProperty', path: config.imagePath, key, value });
}

function isHexColor(value: unknown): boolean {
    return typeof value === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim());
}
function normalizeHex(value: string): string {
    const hex = value.trim().toLowerCase();
    if (hex.length === 4) {
        return '#' + hex.slice(1).split('').map(ch => ch + ch).join('');
    }
    return hex;
}
/**
 * Wallpaper Engine 的颜色属性有两种写法：`#rrggbb` 和 `r g b`（0..1 浮点或 0..255）。
 * 统一换算成 6 位 hex 交给取色器，写回时保持原来的写法。
 */
function colorHex(property: WallpaperProperty): string {
    const raw = String(property.value ?? '');
    if (isHexColor(raw)) { return normalizeHex(raw); }
    const parts = raw.trim().split(/[\s,]+/).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
        const scale = parts.slice(0, 3).every(value => value <= 1) ? 255 : 1;
        return '#' + parts.slice(0, 3)
            .map(value => Math.max(0, Math.min(255, Math.round(value * scale))).toString(16).padStart(2, '0'))
            .join('');
    }
    return '#000000';
}
function updateColorProperty(property: WallpaperProperty, value: string | null) {
    if (!value) { return; }
    const hex = normalizeHex(value);
    const raw = String(property.value ?? '');
    const parts = raw.trim().split(/[\s,]+/).map(Number);
    const usesFloat = !isHexColor(raw) && parts.length >= 3 && parts.slice(0, 3).every(n => Number.isFinite(n) && n <= 1);
    const channels = [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16));
    if (usesFloat) {
        property.value = channels.map(channel => Number((channel / 255).toFixed(2))).join(' ');
    } else if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
        property.value = channels.join(' ');
    } else {
        property.value = hex;
    }
    updateWallpaperProperty(property.key, property.value);
}
function sliderMin(property: WallpaperProperty): number {
    return Number.isFinite(property.min as number) ? Number(property.min) : 0;
}
function sliderMax(property: WallpaperProperty): number {
    return Number.isFinite(property.max as number) ? Number(property.max) : 1;
}
function sliderStep(property: WallpaperProperty): number {
    const step = Number(property.step);
    return Number.isFinite(step) && step > 0 ? step : 0.01;
}

const propertyTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** 滑块拖动时事件很密集，节流到 60ms 再落盘：既有实时感，又不会刷爆消息通道。 */
function onPropertySliderInput(property: WallpaperProperty) {
    const pending = propertyTimers.get(property.key);
    if (pending) { clearTimeout(pending); }
    propertyTimers.set(property.key, setTimeout(() => {
        propertyTimers.delete(property.key);
        updateWallpaperProperty(property.key, property.value);
    }, 60));
}

function resetViewOffset() {
    cameraPanX.value = PAN_DEFAULT;
    cameraPanY.value = PAN_DEFAULT;
    onViewOffsetInput();
}

function onViewOffsetInput() {
    if (!config.imagePath) { return; }
    // 饱和裁剪：拖过头就停在最大/最小，不会弹回拖动前的值。
    cameraPanX.value = clampRange(Number(cameraPanX.value), PAN_MIN, PAN_MAX);
    cameraPanY.value = clampRange(Number(cameraPanY.value), PAN_MIN, PAN_MAX);
    xyDirtyUntil = Date.now() + 1200;
    if (viewOffsetTimer) { clearTimeout(viewOffsetTimer); }
    viewOffsetTimer = setTimeout(() => {
        if (!config.imagePath) { return; }
        bridge.post({
            type: 'setWallpaperProperties',
            path: config.imagePath,
            properties: {
                wallpaperstudio_pan_x: cameraPanX.value,
                wallpaperstudio_pan_y: cameraPanY.value
            }
        });
    }, 60);
}
</script>

<style lang="scss" scoped>
.home-tab { display: flex; flex-direction: column; gap: 12px; }

.preview-card :deep(.el-card__body) { padding: 10px; }

.preview-frame {
    position: relative;
    width: 100%;
    aspect-ratio: 16 / 9;
    border-radius: 6px;
    overflow: hidden;
    background: var(--studio-input-bg);
    border: 1px solid rgba(125, 175, 230, 0.18);
    box-shadow:
        0 0 0 1px rgba(56, 189, 248, 0.06) inset,
        0 10px 30px rgba(0, 0, 0, 0.35);
    transition: transform 0.18s ease, box-shadow 0.18s ease;
    img, video { width: 100%; height: 100%; object-fit: cover; display: block;     }

    .thumbnail-source {
        position: absolute;
        width: 1px;
        height: 1px;
        opacity: 0;
        pointer-events: none;
    }
    &.is-empty {
        display: flex;
        align-items: center;
        justify-content: center;
    }
    &:hover {
        transform: translateY(-1px);
        box-shadow:
            0 0 0 1px var(--studio-accent) inset,
            0 14px 36px rgba(56, 189, 248, 0.25);
    }
}

.preview-empty {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;

    .preview-error-detail {
        max-width: 82%;
        text-align: center;
        font-size: 11px;
        line-height: 1.4;
        color: var(--vscode-errorForeground);
        opacity: 0.9;
    }
}

.preview-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    padding: 10px;
    opacity: 0;
    transition: opacity 0.18s ease;
    background: linear-gradient(to top, rgba(0,0,0,0.7), transparent 55%);
    .preview-frame:hover &,
    .preview-frame.is-empty & { opacity: 1; }
}

.preview-meta {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    padding: 10px 4px 2px;
    margin-top: 8px;
    border-top: var(--studio-divider);
    font-size: 11px;
}
.meta-label { color: var(--vscode-descriptionForeground); flex-shrink: 0; }
.meta-path  {
    flex: 1 1 auto;
    text-align: right;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    color: var(--vscode-foreground);
    font-family: 'Consolas', 'SFMono-Regular', Menlo, monospace;
}

.section-card :deep(.el-card__header) { padding: 8px 12px; }
.section-card :deep(.el-card__body)   { padding: 10px 12px 6px; }
.global-setting { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
.global-setting label {
    min-width: 56px;
    max-width: 40%;
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.global-setting .el-slider { flex: 1; }

.property-group {
    margin-top: 14px;
    padding-bottom: 4px;
    font-size: 12px;
    font-weight: 600;
    color: var(--studio-accent);
    border-bottom: var(--studio-divider);
}
.property-header {
    margin-top: 10px;
    font-size: 11px;
    letter-spacing: 0.02em;
    color: var(--vscode-descriptionForeground);
}
.property-label {
    margin-top: 8px;
    font-size: 11px;
    line-height: 1.5;
    color: var(--vscode-descriptionForeground);
}
.xy-settings { margin-top: 12px; padding-top: 8px; border-top: var(--studio-divider); }
.xy-row { display: flex; align-items: center; gap: 10px; }
.xy-row label { min-width: 56px; font-size: 11px; }
.xy-row .el-slider { flex: 1; }
.xy-reset { justify-content: flex-end; margin-top: 2px; }

.card-title {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 600;
    color: var(--vscode-foreground);
    .el-icon { color: var(--studio-accent); }
}

.slider-row {
    display: grid;
    grid-template-columns: 56px 1fr;
    align-items: center;
    gap: 12px;
    padding: 4px 0;
    label {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
    }
}

.action-center :deep(.el-card__body) { padding: 10px 12px 12px; }

.action-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
}

.action-tile {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border-radius: 8px;
    background: var(--studio-btn-soft, rgba(26, 50, 84, 0.85));
    border: 1px solid var(--studio-btn-soft-border, rgba(125, 175, 230, 0.35));
    color: var(--vscode-foreground);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
    box-shadow:
        0 1px 0 rgba(255, 255, 255, 0.04) inset,
        0 2px 6px rgba(0, 0, 0, 0.25);
    transition: transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease, border-color 0.15s ease;

    &:hover {
        transform: translateY(-1px);
        background: var(--studio-btn-soft-hover, rgba(36, 72, 118, 0.95));
        border-color: rgba(140, 195, 240, 0.55);
        box-shadow:
            0 1px 0 rgba(255, 255, 255, 0.06) inset,
            0 6px 16px rgba(56, 189, 248, 0.25);
    }

    &:active { transform: translateY(0); }
}

.tile-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border-radius: 7px;
    flex-shrink: 0;
    color: #fff;
    font-size: 16px;
    box-shadow:
        0 1px 0 rgba(255, 255, 255, 0.18) inset,
        0 4px 10px rgba(0, 0, 0, 0.3);

    .el-icon { font-size: 16px; }

    &--blue {
        background: linear-gradient(135deg, #38bdf8 0%, #1d4ed8 100%);
        box-shadow:
            0 1px 0 rgba(255, 255, 255, 0.2) inset,
            0 4px 12px rgba(56, 189, 248, 0.45);
    }
    &--red {
        background: linear-gradient(135deg, #ff7a8a 0%, #e8556a 100%);
        box-shadow:
            0 1px 0 rgba(255, 255, 255, 0.2) inset,
            0 4px 12px rgba(232, 85, 106, 0.45);
    }
    &--cyan {
        background: linear-gradient(135deg, #66d4e0 0%, #36b3c2 100%);
        box-shadow:
            0 1px 0 rgba(255, 255, 255, 0.2) inset,
            0 4px 12px rgba(54, 179, 194, 0.45);
    }
    &--pink {
        background: linear-gradient(135deg, #ff9ec7 0%, #ec6aa7 100%);
        box-shadow:
            0 1px 0 rgba(255, 255, 255, 0.2) inset,
            0 4px 12px rgba(236, 106, 167, 0.45);
    }
    &--slate {
        background: linear-gradient(135deg, #8a93a8 0%, #5b6478 100%);
        box-shadow:
            0 1px 0 rgba(255, 255, 255, 0.2) inset,
            0 4px 12px rgba(91, 100, 120, 0.45);
    }
    &--amber {
        background: linear-gradient(135deg, #ffc46b 0%, #f0993a 100%);
        box-shadow:
            0 1px 0 rgba(255, 255, 255, 0.2) inset,
            0 4px 12px rgba(240, 153, 58, 0.45);
    }
    &--gold {
        background: linear-gradient(135deg, #ffd76b 0%, #e8b021 100%);
        box-shadow:
            0 1px 0 rgba(255, 255, 255, 0.2) inset,
            0 4px 12px rgba(232, 176, 33, 0.45);
    }
    &--green {
        background: linear-gradient(135deg, #6fd88a 0%, #35a85c 100%);
        box-shadow:
            0 1px 0 rgba(255, 255, 255, 0.2) inset,
            0 4px 12px rgba(53, 168, 92, 0.45);
    }
}

.about-card :deep(.el-card__body) { padding: 10px 12px 12px; }

.about-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
}

/* 侧边栏很窄，四个入口改成 2x2 竖排图标+文字，避免横排时文字被截断 */
.about-tile {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 10px 4px;
    border-radius: 8px;
    background: var(--studio-btn-soft, rgba(26, 50, 84, 0.85));
    border: 1px solid var(--studio-btn-soft-border, rgba(125, 175, 230, 0.35));
    color: var(--vscode-foreground);
    cursor: pointer;
    box-shadow:
        0 1px 0 rgba(255, 255, 255, 0.04) inset,
        0 2px 6px rgba(0, 0, 0, 0.25);
    transition: transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease, border-color 0.15s ease;

    &:hover {
        transform: translateY(-1px);
        background: var(--studio-btn-soft-hover, rgba(36, 72, 118, 0.95));
        border-color: rgba(140, 195, 240, 0.55);
        box-shadow:
            0 1px 0 rgba(255, 255, 255, 0.06) inset,
            0 6px 16px rgba(56, 189, 248, 0.25);
    }

    &:active { transform: translateY(0); }
}

.about-label {
    font-size: 11px;
    line-height: 1.2;
    color: var(--vscode-foreground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
}

.tile-label {
    font-size: 12px;
    line-height: 1.2;
    color: var(--vscode-foreground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
</style>
