export class BackgroundPatchError extends Error {
    readonly tryNextImage: boolean = false;

    constructor(message: string) {
        super(message);
        this.name = 'BackgroundPatchError';
    }
}

export class BackgroundApplyCancelledError extends Error {
    readonly tryNextImage: boolean = false;

    constructor() {
        super('Background apply cancelled');
        this.name = 'BackgroundApplyCancelledError';
    }
}
