/**
 * The one rule about what may be looked up in the interpreter: a plain dotted
 * Python name, and nothing else.
 *
 * Shared by the editor (which decides whether `np.` is a lookup at all) and the
 * kernel (which refuses to ask Python about anything that isn't), so the two
 * cannot drift apart.
 */
export const ATTRS_PATH = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/
