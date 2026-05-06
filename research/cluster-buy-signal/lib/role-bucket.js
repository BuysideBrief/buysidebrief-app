/**
 * Normalize a Form 4 reportingOwner relationship into one of five role buckets.
 * Used for cohort composition tagging (officer_only / director_only / mixed,
 * with owner_involved as a non-exclusive sub-flag).
 *
 *   c_suite           — CEO/CFO/COO/CTO/CIO/CMO/CHRO/PRESIDENT/CHAIRMAN/CHIEF
 *   vp                — VP / SVP / EVP / "Vice President"
 *   director          — flagged isDirector AND no officer title
 *   ten_percent_owner — flagged isTenPercentOwner AND no officer/director role
 *   officer_other     — isOfficer flagged but title doesn't match c_suite or vp
 *
 * If a person is both director + officer, the officer title wins (more
 * informative). Ten-percent-owner flag is captured as a separate bool used
 * for the cross-cut "owner_involved" composition tag.
 */
function bucketRole({ officerTitle = '', isOfficer = false, isDirector = false, isTenPercent = false }) {
  const title = (officerTitle || '').toUpperCase();

  const hasVP = /\b(VP|SVP|EVP|VICE\s+PRESIDENT)\b/.test(title);
  const hasCSuite = /\b(CHIEF|CEO|CFO|COO|CTO|CIO|CMO|CHRO|CSO|CLO|PRESIDENT|CHAIRMAN|CHAIRWOMAN|CHAIR)\b/.test(title);

  if (isOfficer || title) {
    // VP-tier wins over c-suite when both match (e.g. "Senior Vice President"
    // matches PRESIDENT in the c_suite regex but is a VP-tier role).
    if (hasVP) return 'vp';
    if (hasCSuite) return 'c_suite';
    if (title || isOfficer) return 'officer_other';
  }
  if (isDirector) return 'director';
  if (isTenPercent) return 'ten_percent_owner';
  return 'officer_other'; // safe fallback — shouldn't happen on a clean Form 4
}

const OFFICER_BUCKETS = new Set(['c_suite', 'vp', 'officer_other']);

if (require.main === module) {
  const cases = [
    { in: { officerTitle: 'Chief Executive Officer', isOfficer: true }, out: 'c_suite' },
    { in: { officerTitle: 'CEO', isOfficer: true }, out: 'c_suite' },
    { in: { officerTitle: 'President', isOfficer: true }, out: 'c_suite' },
    { in: { officerTitle: 'EVP, Engineering', isOfficer: true }, out: 'vp' },
    { in: { officerTitle: 'Senior Vice President', isOfficer: true }, out: 'vp' },
    { in: { officerTitle: 'General Counsel', isOfficer: true }, out: 'officer_other' },
    { in: { officerTitle: '', isDirector: true }, out: 'director' },
    { in: { officerTitle: '', isTenPercent: true }, out: 'ten_percent_owner' },
    { in: { officerTitle: 'CFO', isOfficer: true, isDirector: true }, out: 'c_suite' },
  ];
  for (const c of cases) {
    const got = bucketRole(c.in);
    if (got !== c.out) throw new Error(`bucketRole(${JSON.stringify(c.in)}) = ${got}, expected ${c.out}`);
  }
  console.log('role-bucket sanity OK:', cases.length, 'cases');
}

module.exports = { bucketRole, OFFICER_BUCKETS };
