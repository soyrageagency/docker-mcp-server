/*
 * Empty stand-in for `ssh2`, used only when building the standalone binary.
 *
 * docker-modem `require()`s ssh2 at load time to support Docker-over-SSH hosts,
 * but ragedocker talks to the daemon over a local socket or TCP — never SSH — so
 * the real module (with its native crypto addon) would only bloat the binary and
 * can't be embedded anyway. Aliasing it to this stub keeps the bundle loading;
 * the SSH code path is simply never exercised.
 *
 * Crafted by SoyRage Agency — https://soyrage.es/
 */
module.exports = {};
