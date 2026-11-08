import { computed, onUnmounted, ref, watch } from 'vue';
import { config } from './useStore';
import { useBridge } from './useBridge';

/** Measure only an unknown shared limit or an explicit button request. */
export function useDisplayFps() {
    const bridge = useBridge();
    const refreshLimit = computed(() => config.maxFps || 60);
    const fpsReading = ref(false);
    const fpsReadFailed = ref(false);
    let generation = 0;
    let frame = 0;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let automaticAttempted = false;
    let forced = false;
    let disposed = false;
    const stop = () => {
        generation++;
        cancelAnimationFrame(frame);
        clearTimeout(deadline);
        fpsReading.value = false;
    };
    function sampleDisplayRate(overwrite = true) {
        if (disposed || fpsReading.value || document.hidden || config.maxFps === undefined) { return; }
        if (!overwrite && (automaticAttempted || config.maxFps !== 0)) { return; }
        automaticAttempted = true;
        forced = overwrite;
        fpsReading.value = true;
        fpsReadFailed.value = false;
        const current = ++generation;
        const samples: number[] = [];
        let previous: number | undefined;
        deadline = setTimeout(() => { stop(); fpsReadFailed.value = true; }, 5000);
        const tick = (time: number) => {
            if (disposed || current !== generation) { return; }
            if (document.hidden) { stop(); automaticAttempted = false; return; }
            if (previous !== undefined && time > previous) { samples.push(time - previous); }
            previous = time;
            if (samples.length < 30) { frame = requestAnimationFrame(tick); return; }
            const sorted = samples.slice(6).sort((a, b) => a - b);
            const maxFps = Math.max(15, Math.round(1000 / sorted[Math.floor(sorted.length / 2)]));
            stop();
            bridge.post({ type: 'saveDisplayFps', maxFps, overwrite });
        };
        frame = requestAnimationFrame(tick);
    }
    const readIfMissing = () => { if (config.maxFps === 0) { sampleDisplayRate(false); } };
    const unwatch = watch(() => config.maxFps, value => {
        // Another host may have completed the first measurement in the meantime.
        if (value && fpsReading.value && !forced) { stop(); }
        readIfMissing();
    }, { immediate: true });
    document.addEventListener('visibilitychange', readIfMissing);
    onUnmounted(() => {
        disposed = true;
        stop();
        unwatch();
        document.removeEventListener('visibilitychange', readIfMissing);
    });
    return { refreshLimit, fpsReading, fpsReadFailed, sampleDisplayRate };
}
