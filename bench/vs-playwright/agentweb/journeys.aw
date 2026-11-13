# The same journeys as ../playwright/journeys.spec.ts. Each test gets its own world (app/world.mjs).
# expect-timeout: 10

## sign in, wrong password, sign out
# setup: node app/world.mjs
open('/login'); fill('Email', '${email}'); fill('Password', 'not-the-password'); click('Sign in')
expect('Wrong email or password.'); expect(url='/login')
fill('Email', '${email}'); fill('Password', '${password}'); click('Sign in')
expect('Today', role='heading', level=1)
click('Sign out'); expect(url='/login')
open('/home'); expect(url='/login'); expect('Sign in to Tock', role='heading', level=1)

## staff cannot open the bug reports
# setup: node app/world.mjs
# profile: ${profile}
open('/admin/reports'); expect('Not allowed', role='heading', level=1)

## report a problem: staff sends, instructor reads
# setup: node app/world.mjs
profile(file='${profile}'); open('/students')
click('Report a problem'); expect(focused='What went wrong')
click('Send report', in='dialog:Report a problem'); expect('Your report was sent.'); expect(role='dialog', hidden=1)
click('Report a problem'); fill('What went wrong', 'The history page froze ${sid}'); click('Send report')
expect('Your report was sent.'); expect(role='dialog', hidden=1)
profile(file='${admin_profile}'); open('/admin/reports')
expect('Bug reports', role='heading', level=1); expect('The history page froze ${sid}')

## add a student
# setup: node app/world.mjs
# profile: ${profile}
open('/students'); expect('0 students')
click('Add student'); expect('Name is required')
fill('Student name', 'Ada Lovelace'); select('Grade', '3'); click('Add student')
expect(role='row', name='Ada Lovelace 3'); expect('1 student', exact=1)
reload(); expect(role='row', name='Ada Lovelace 3'); expect(requests=0, console=0, all=1)

## instructor picks the kiosk way; Clock in shows only the code
# setup: node app/world.mjs
# profile: ${admin_profile}
open('/settings'); check('Showing their code to the kiosk'); expect('Saved. Staff see the new way')
reload(); expect(checked='Showing their code to the kiosk')
profile(file='${profile}'); open('/scan')
expect(role='textbox', name='Clock-in code'); expect('New code in 1:'); expect(role='region', name='QR code scanner', n=0)

## parent signs up with an emailed code
# setup: node app/world.mjs
open('/signup'); fill('Your email', 'parent-${center}@test.example'); click('Send me a code')
expect('Check your email')
mail(to='parent-${center}@test.example', subject='Your Tock code', wait=15, api='${base}/mailpit')
fill('Code', '${mail.code}'); click('Create account')
expect('Welcome, Pat Parent', role='heading', level=1)

## kiosk without a camera takes an uploaded photo
# setup: node app/world.mjs
# profile: ${profile}
open('/kiosk'); upload('Card photo', 'app/card.png'); expect('Photo received: card.png (70 bytes)')

## design sweep at ${width}px
# each: width in 390, 1440
# setup: node app/world.mjs
# profile: ${profile}
# console: clean
emulate(${width}, 900)
open('/home'); expect(role='heading', level=1); expect(overflow=0, requests=0, console=0, axe=0, impact='serious', disable='color-contrast', audit='target')
expect(same='menu', of='nav [data-menu]')
open('/students'); expect(role='heading', level=1); expect(overflow=0, requests=0, console=0, axe=0, impact='serious', disable='color-contrast', audit='target')
expect(same='menu', of='nav [data-menu]')
open('/settings'); expect(role='heading', level=1); expect(overflow=0, requests=0, console=0, axe=0, impact='serious', disable='color-contrast', audit='target')
expect(same='menu', of='nav [data-menu]')
open('/kiosk'); expect(role='heading', level=1); expect(overflow=0, requests=0, console=0, axe=0, impact='serious', disable='color-contrast', audit='target')
expect(same='menu', of='nav [data-menu]')
profile(file='${admin_profile}'); open('/admin/reports'); expect(role='heading', level=1); expect(overflow=0, requests=0, console=0, axe=0, impact='serious', disable='color-contrast', audit='target')
