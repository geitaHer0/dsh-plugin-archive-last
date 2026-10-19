//#region lib/index.js
/**
 * archive-last, node half. The feature is browser presentation only: the
 * empty `apply` gives the Loader a host-side row so the client half in
 * `exports["./client"]` is discovered from the package.json `dsh.client`
 * declaration. No host API is touched.
 */
function apply() {}
//#endregion

export { apply }
