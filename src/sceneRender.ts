/**
 * Complete input contract for a Wallpaper Engine scene render.
 *
 * Both the injected background renderer and the Webview preview must consume
 * this shape. Keeping it separate from UI state prevents either side from
 * silently dropping project declarations or property overrides.
 */
export interface SceneRenderConfig {
    url: string;
    title: string;
    project?: unknown;
    properties: Record<string, unknown>;
    opacity: number;
    blur: number;
    blendMode: string;
}

export function createSceneRenderConfig(input: SceneRenderConfig): SceneRenderConfig {
    return {
        url: input.url,
        title: input.title,
        project: input.project,
        properties: { ...input.properties },
        opacity: input.opacity,
        blur: input.blur,
        blendMode: input.blendMode
    };
}
