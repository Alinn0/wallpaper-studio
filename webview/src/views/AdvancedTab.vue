<template>
    <div class="advanced-tab">
        <!-- Auto random -->
        <el-card class="card" shadow="never">
            <template #header>
                <span class="card-title">
                    <el-icon><Refresh /></el-icon>
                    {{ t('autoRandom') }}
                </span>
            </template>

            <div class="row">
                <span class="row-label">{{ t('enabled') }}</span>
                <el-switch
                    :model-value="!!config.autoStatus"
                    @change="(v: any) => bridge.post({ type: 'setConfig', key: 'autoStatus', value: v })"
                />
            </div>

            <div class="row">
                <span class="row-label">{{ t('intervalSeconds') }}</span>
                <el-input-number
                    :model-value="Number(config.autoInterval ?? 10)"
                    :min="3"
                    :max="3600"
                    :step="1"
                    size="small"
                    controls-position="right"
                    class="interval-input"
                    @change="onIntervalChange"
                />
            </div>

        </el-card>

        <!-- Window scope -->
        <el-card class="card" shadow="never">
            <template #header>
                <span class="card-title">
                    <el-icon><Monitor /></el-icon>
                    {{ t('windowScope') }}
                </span>
            </template>

            <div class="row">
                <span class="row-label">{{ t('perWindowBackground') }}</span>
                <el-switch
                    :model-value="config.perWindowBackground !== false"
                    @change="(v: any) => bridge.post({ type: 'setConfig', key: 'perWindowBackground', value: v })"
                />
            </div>
            <div class="row-hint">{{ t('perWindowBackgroundHint') }}</div>
        </el-card>

        <!-- Size mode -->
        <el-card class="card" shadow="never">
            <template #header>
                <span class="card-title">
                    <el-icon><FullScreen /></el-icon>
                    {{ t('sizeMode') }}
                </span>
            </template>
            <el-select
                :model-value="config.sizeModel"
                size="small"
                class="block-select"
                @change="(v: any) => bridge.post({ type: 'setConfig', key: 'sizeModel', value: v })"
            >
                <el-option v-for="opt in sizeModeOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
            </el-select>
        </el-card>

        <!-- Blend mode -->
        <el-card class="card" shadow="never">
            <template #header>
                <span class="card-title">
                    <el-icon><Brush /></el-icon>
                    {{ t('blendMode') }}
                </span>
            </template>
            <el-select
                :model-value="config.blendModel"
                size="small"
                class="block-select"
                @change="(v: any) => bridge.post({ type: 'setConfig', key: 'blendModel', value: v })"
            >
                <el-option v-for="opt in blendModeOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
            </el-select>
            <div class="row-hint">{{ t('blendModeHint') }}</div>
        </el-card>

        <!-- Misc -->
        <el-card class="card" shadow="never">
            <div class="quick-actions">
                <el-button class="block-btn" @click="onOpenCache">
                    <el-icon><FolderOpened /></el-icon>
                    {{ t('openCacheFolder') }}
                </el-button>
            </div>
        </el-card>

        <!-- 危险操作放在最底部 -->
        <el-card class="card danger-card" shadow="never">
            <div class="quick-actions">
                <el-button class="block-btn" type="danger" @click="onClearAll">
                    <el-icon><Delete /></el-icon>
                    {{ resetPending ? t('clearAllDataConfirm') : t('clearAllData') }}
                </el-button>
            </div>
            <div class="row-hint">{{ t('clearAllDataHint') }}</div>
        </el-card>
    </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { Refresh, FullScreen, Brush, FolderOpened, Monitor, Delete } from '@element-plus/icons-vue';
import { useI18n, type MessageKey } from '../composables/useI18n';
import { useBridge } from '../composables/useBridge';
import { useDebouncedPost } from '../composables/useDebouncedPost';
import { config } from '../composables/useStore';
import { ActionType, SIZE_MODES, BLEND_MODES } from '../constants';

const { t } = useI18n();
const bridge = useBridge();

// 下拉框显示翻译后的名称，发送给扩展的值保持原枚举值不变
const SIZE_MODE_LABEL_KEYS: Record<string, MessageKey> = {
    cover:            'sizeModeCover',
    repeat:           'sizeModeRepeat',
    contain:          'sizeModeContain',
    center:           'sizeModeCenter',
    not_center:       'sizeModeNotCenter',
    not_right_bottom: 'sizeModeNotRightBottom',
    not_right_top:    'sizeModeNotRightTop',
    not_left:         'sizeModeNotLeft',
    not_right:        'sizeModeNotRight',
    not_top:          'sizeModeNotTop',
    not_bottom:       'sizeModeNotBottom'
};
const BLEND_MODE_LABEL_KEYS: Record<string, MessageKey> = {
    auto:     'blendModeAuto',
    multiply: 'blendModeMultiply',
    lighten:  'blendModeLighten'
};

const intervalPost = useDebouncedPost('setConfig', 'autoInterval', { delay: 300 });
function onIntervalChange(v: number | undefined) {
    const value = Number(v ?? 10);
    config.autoInterval = value;
    intervalPost.post(value);
}


const sizeModeOptions = computed(() => SIZE_MODES.map((value) => ({
    value,
    label: t(SIZE_MODE_LABEL_KEYS[value] ?? 'sizeModeCover')
})));
const blendModeOptions = computed(() => BLEND_MODES.map((value) => ({
    value,
    label: t(BLEND_MODE_LABEL_KEYS[value] ?? 'blendModeAuto')
})));

function onOpenCache()    { bridge.post({ type: 'runAction', action: ActionType.OpenCacheFolder }); }

/** 清除所有缓存与配置：危险操作，需要连续点击两次确认。 */
const resetPending = ref(false);
let resetTimer: ReturnType<typeof setTimeout> | undefined;
function onClearAll() {
    if (!resetPending.value) {
        resetPending.value = true;
        if (resetTimer) { clearTimeout(resetTimer); }
        resetTimer = setTimeout(() => { resetPending.value = false; }, 4000);
        return;
    }
    if (resetTimer) { clearTimeout(resetTimer); resetTimer = undefined; }
    resetPending.value = false;
    bridge.post({ type: 'resetAll' });
}
onUnmounted(() => { if (resetTimer) { clearTimeout(resetTimer); } });
</script>

<style lang="scss" scoped>
.advanced-tab { display: flex; flex-direction: column; gap: 12px; }

.card :deep(.el-card__header) { padding: 8px 12px; }
.card :deep(.el-card__body)   { padding: 10px 12px; }

.card-title {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 600;
    color: var(--vscode-foreground);
    .el-icon { color: var(--studio-accent); }
}

.row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 0;
    & + .row { border-top: var(--studio-divider); }
}

.row-label {
    font-size: 12px;
    color: var(--vscode-foreground);
}

.row-hint {
    font-size: 11px;
    line-height: 1.5;
    color: var(--vscode-descriptionForeground);
    opacity: .85;
    padding-top: 6px;
    border-top: var(--studio-divider);
}

.folder-btn {
    max-width: 70%;
    overflow: hidden;
    .folder-text {
        max-width: 140px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        direction: rtl;
    }
}

.block-select { width: 100%; }

.interval-input { width: 120px; }

.quick-actions {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
}

.block-btn.block-btn {
    width: 100% !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    text-align: center;
    margin: 0 !important;
}

.block-btn :deep(> span) {
    width: 100%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
}
</style>
