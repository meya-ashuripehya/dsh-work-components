/** Preserve useful Error fields without relying on non-enumerable properties. */
export function toLoggableError(error) {
    return normalizeError(error, new Set());
}
function normalizeError(error, seen) {
    if (!(error instanceof Error)) {
        return { name: 'NonErrorThrown', message: formatUnknown(error) };
    }
    if (seen.has(error)) {
        return { name: error.name, message: `${error.message} (circular cause)` };
    }
    seen.add(error);
    const result = {
        name: error.name,
        message: error.message,
        stack: error.stack,
    };
    if (error.cause !== undefined)
        result.cause = normalizeError(error.cause, seen);
    return result;
}
function formatUnknown(value) {
    if (typeof value === 'string')
        return value;
    try {
        return JSON.stringify(value) ?? String(value);
    }
    catch {
        return String(value);
    }
}
//# sourceMappingURL=loggable-error.js.map