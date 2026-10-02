'use strict';
// Host-owned child execution re-enters the ordinary FC/Requesty path. This
// module supplies its protocol and capabilities; it never starts background
// promises in a Function Compute invocation.
module.exports = (() => {
  try { return require('./shared/generic-subagent.js'); }
  catch { return require('../shared/generic-subagent.js'); }
})();
