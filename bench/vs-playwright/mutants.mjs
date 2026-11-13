// Planted bugs (a good suite must FAIL on each) and benign variants (a good suite must PASS on each).
// `cause`: a regex that the failure output should match for the report to name the cause by itself,
// without opening a trace (time-to-diagnose). Checked against the tool's whole terminal output.
export const MUTANTS = [
  { name: 'login-any-password', what: 'sign-in accepts a wrong password', cause: /Wrong email or password/i },
  { name: 'login-error-silent', what: 'a wrong password shows no message', cause: /Wrong email or password/i },
  { name: 'signout-broken', what: 'signing out keeps the session alive', cause: /login|Sign in/i },
  { name: 'admin-page-open', what: 'an employee can open the instructor-only bug reports', cause: /Not allowed/i },
  { name: 'report-no-focus', what: 'the report dialog does not focus its text box', cause: /focus/i },
  { name: 'report-no-toast', what: 'sending a report shows no confirmation', cause: /report was sent/i },
  { name: 'report-dialog-stays', what: 'the report dialog stays open after sending', cause: /dialog|hidden|Send report|open/i },
  { name: 'report-not-saved', what: 'the report is acknowledged but never saved', cause: /history page froze|ticket|note/i },
  { name: 'student-no-validation', what: 'an empty student name is accepted', cause: /Name is required/i },
  { name: 'student-count-off', what: 'the student count is off by one', cause: /1 student|2 students/i },
  { name: 'student-not-persisted', what: 'a new student disappears after reload', cause: /Ada Lovelace/i },
  { name: 'api-500-swallowed', what: 'the save API fails with 500 but the page pretends it worked', cause: /500|api\/students/i },
  { name: 'settings-not-persisted', what: 'the clock-in setting is lost after reload', cause: /kiosk|checked|QR code scanner/i },
  { name: 'scan-shows-both', what: 'Clock in shows the QR scanner although the kiosk way was chosen', cause: /QR code scanner/i },
  { name: 'mail-wrong-code', what: 'the email carries a different code from the one accepted', cause: /code is not right|Welcome/i },
  { name: 'mail-not-sent', what: 'the sign-up code email is never sent', cause: /mail|message|inbox/i },
  { name: 'upload-ignored', what: 'an uploaded photo is not acknowledged', cause: /Photo received/i },
  { name: 'overflow-phone', what: 'the students table scrolls sideways on a phone', cause: /overflow|sideways|scrollWidth|wider/i },
  { name: 'tap-small', what: 'the Report a problem button is 18 px on a phone', cause: /18\s*[x×]\s*18|target|tap|small/i },
  { name: 'console-error', what: 'Settings throws a script error', cause: /TypeError|Cannot read|null/i },
  { name: 'asset-404', what: 'Home loads a stylesheet that does not exist', cause: /theme\.css|404/i },
  { name: 'no-h1', what: 'Students has no main heading', cause: /heading|h1/i },
  { name: 'axe-unnamed-button', what: 'an icon button without an accessible name (axe)', cause: /button-name|discernible|name/i },
  { name: 'menu-drift', what: 'one page shows a different menu', cause: /Kiosk|menu/i },
];

export const BENIGN = [
  { name: 'slow', what: 'every API call takes 1.2 s and the page hydrates after 1 s' },
  { name: 'jitter', what: 'random 0-0.7 s latency on every API call and hydration' },
  { name: 'restyle', what: 'every class name changes and an extra wrapper is added (same text and roles)' },
  { name: 'animations', what: 'the dialog fades and slides in over 0.4 s' },
  { name: 'toast-quick', what: 'toasts disappear after 1.5 s instead of 5 s' },
];
