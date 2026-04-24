// export default on a primitive + coexisting named export. Fallback path:
// stub can't mutate the default value so emits exports.default = …; the
// named export survives, default gets the expected double-wrap.
export default 42;
export const helper = { kind: "HLP" };
