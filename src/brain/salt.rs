//! Build salt. Every salted build is a different program whose play is decorrelated from the others:
//! the salt moves the pilot's random stream (juke side and timing, burst side timing, search samples)
//! and the phase of the idle look-around. It changes no rule and no threshold. SALT = 0 changes nothing.

/// Set by scripts/ship/abase-variants.sh (one value per variant).
pub(crate) const SALT: u64 = 7;

/// 64 pseudo-random bits for stream `k` of this build; 0 when SALT is 0.
pub(crate) fn word(k: u64) -> u64 {
    if SALT == 0 {
        return 0;
    }
    let mut z = SALT.wrapping_mul(0xD6E8_FEB8_6659_FD93).wrapping_add(k.wrapping_mul(0xA24B_AED4_963E_E407));
    z = (z ^ (z >> 32)).wrapping_mul(0xD6E8_FEB8_6659_FD93);
    z = (z ^ (z >> 32)).wrapping_mul(0xD6E8_FEB8_6659_FD93);
    z ^ (z >> 32)
}

/// Uniform in [0, 1) for stream `k` of this build; 0.0 when SALT is 0.
pub(crate) fn unit(k: u64) -> f64 {
    (word(k) >> 11) as f64 / (1u64 << 53) as f64
}
