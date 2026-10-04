// Where someone stuck installing AEON asks for help. One place, so the
// welcome screen and the README never disagree, and changing the channel
// (an email, a site) is one line. Opening it is the user's click — nothing
// is sent anywhere on its own.
export const HELP_URL = 'https://github.com/cgomez1365/AEON/issues/new?template=install-help.yml';

// The private channel, for anyone who would rather not post in public. It
// forwards to the maintainer; the README and SECURITY.md name the same address.
export const HELP_EMAIL = 'aeon@brokengearindustries.com';

// The terms AEON is used under, as published on main. The welcome screen links
// them; nothing in the app or the launcher did before (audit #25, 2026-10-03).
const REPO_MAIN = 'https://github.com/cgomez1365/AEON/blob/main';
export const TERMS_URL = `${REPO_MAIN}/TERMS_OF_USE.md`;
export const LICENSE_URL = `${REPO_MAIN}/LICENSE`;
export const PRIVACY_URL = `${REPO_MAIN}/PRIVACY.md`;
