# -*- coding: utf-8 -*-
"""
Builds the SiteOps user guide as a PDF.

Written for the people who will actually use the system: site supervisors, store
keepers, the QS team and the office. No technical words, short sentences, and every
instruction phrased as something to do rather than something to know.
"""
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer,
                                Table, TableStyle, PageBreak, KeepTogether, ListFlowable,
                                ListItem, HRFlowable)

INK    = colors.HexColor('#17211C')
GREEN  = colors.HexColor('#2C7A4F')
BLUE   = colors.HexColor('#176FDA')
AMBER  = colors.HexColor('#8A6210')
AMBERB = colors.HexColor('#FBF0D8')
GREY   = colors.HexColor('#54615A')
LINE   = colors.HexColor('#D7DED9')
SOFT   = colors.HexColor('#F3F6F4')
BLUEB  = colors.HexColor('#E6EFF8')

PAGE_W, PAGE_H = A4
M = 20 * mm

S = {}
S['title'] = ParagraphStyle('title', fontName='Helvetica-Bold', fontSize=30, leading=35,
                            textColor=INK, spaceAfter=6)
S['sub'] = ParagraphStyle('sub', fontName='Helvetica', fontSize=13, leading=19,
                          textColor=GREY, spaceAfter=18)
S['h1'] = ParagraphStyle('h1', fontName='Helvetica-Bold', fontSize=19, leading=24,
                         textColor=INK, spaceBefore=4, spaceAfter=9)
S['h2'] = ParagraphStyle('h2', fontName='Helvetica-Bold', fontSize=13.5, leading=18,
                         textColor=INK, spaceBefore=13, spaceAfter=5)
S['body'] = ParagraphStyle('body', fontName='Helvetica', fontSize=10.5, leading=16,
                           textColor=colors.HexColor('#22302A'), spaceAfter=8, alignment=TA_LEFT)
S['lead'] = ParagraphStyle('lead', parent=S['body'], fontSize=11.5, leading=17.5, textColor=GREY)
S['bullet'] = ParagraphStyle('bullet', parent=S['body'], spaceAfter=4)
S['step'] = ParagraphStyle('step', parent=S['body'], spaceAfter=5)
S['note'] = ParagraphStyle('note', fontName='Helvetica', fontSize=10, leading=15,
                           textColor=colors.HexColor('#3A2F14'))
S['noteh'] = ParagraphStyle('noteh', fontName='Helvetica-Bold', fontSize=10, leading=15,
                            textColor=AMBER, spaceAfter=3)
S['tip'] = ParagraphStyle('tip', fontName='Helvetica', fontSize=10, leading=15,
                          textColor=colors.HexColor('#14304F'))
S['tiph'] = ParagraphStyle('tiph', fontName='Helvetica-Bold', fontSize=10, leading=15,
                           textColor=BLUE, spaceAfter=3)
S['th'] = ParagraphStyle('th', fontName='Helvetica-Bold', fontSize=9.5, leading=13,
                         textColor=colors.white)
S['td'] = ParagraphStyle('td', fontName='Helvetica', fontSize=9.5, leading=13.5,
                         textColor=colors.HexColor('#22302A'))
S['tdb'] = ParagraphStyle('tdb', fontName='Helvetica-Bold', fontSize=9.5, leading=13.5,
                          textColor=INK)
S['cover_small'] = ParagraphStyle('cs', fontName='Helvetica', fontSize=10.5, leading=16,
                                  textColor=GREY)


def note(title, text, kind='warn'):
    head = S['noteh'] if kind == 'warn' else S['tiph']
    body = S['note'] if kind == 'warn' else S['tip']
    bg = AMBERB if kind == 'warn' else BLUEB
    bar = AMBER if kind == 'warn' else BLUE
    inner = [Paragraph(title, head), Paragraph(text, body)]
    t = Table([[inner]], colWidths=[PAGE_W - 2 * M])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), bg),
        ('LEFTPADDING', (0, 0), (-1, -1), 12), ('RIGHTPADDING', (0, 0), (-1, -1), 12),
        ('TOPPADDING', (0, 0), (-1, -1), 10), ('BOTTOMPADDING', (0, 0), (-1, -1), 10),
        ('LINEBEFORE', (0, 0), (0, -1), 3, bar),
    ]))
    return [Spacer(1, 4), t, Spacer(1, 10)]


def steps(items):
    return ListFlowable(
        [ListItem(Paragraph(t, S['step']), leftIndent=18) for t in items],
        bulletType='1', bulletFontName='Helvetica-Bold', bulletFontSize=10.5,
        leftIndent=16, bulletColor=GREEN, spaceAfter=8)


def bullets(items):
    return ListFlowable(
        [ListItem(Paragraph(t, S['bullet']), leftIndent=14) for t in items],
        bulletType='bullet', bulletFontName='Helvetica', bulletFontSize=9,
        leftIndent=12, bulletColor=GREEN, spaceAfter=8)


def table(rows, widths, header=True):
    data = []
    for i, row in enumerate(rows):
        style = S['th'] if (header and i == 0) else S['td']
        data.append([Paragraph(str(c), style) for c in row])
    t = Table(data, colWidths=widths, repeatRows=1 if header else 0)
    cmds = [
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 8), ('RIGHTPADDING', (0, 0), (-1, -1), 8),
        ('TOPPADDING', (0, 0), (-1, -1), 7), ('BOTTOMPADDING', (0, 0), (-1, -1), 7),
        ('LINEBELOW', (0, 0), (-1, -2), 0.5, LINE),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, SOFT]),
    ]
    if header:
        cmds += [('BACKGROUND', (0, 0), (-1, 0), INK)]
    t.setStyle(TableStyle(cmds))
    return [t, Spacer(1, 12)]


class Guide(BaseDocTemplate):
    def __init__(self, path):
        super().__init__(path, pagesize=A4,
                         leftMargin=M, rightMargin=M, topMargin=M, bottomMargin=18 * mm,
                         title='GKUC SiteOps — How to Use the System',
                         author='Infinity AI', subject='User guide for GKUC Construction')
        frame = Frame(M, 18 * mm, PAGE_W - 2 * M, PAGE_H - M - 18 * mm, id='body')
        self.addPageTemplates([
            PageTemplate(id='cover', frames=[frame]),
            PageTemplate(id='main', frames=[frame], onPage=self.decorate),
        ])

    def decorate(self, canvas, doc):
        canvas.saveState()
        canvas.setFont('Helvetica', 8)
        canvas.setFillColor(GREY)
        canvas.drawString(M, 11 * mm, 'GKUC SiteOps — How to Use the System')
        canvas.drawRightString(PAGE_W - M, 11 * mm, str(doc.page))
        canvas.setStrokeColor(LINE)
        canvas.setLineWidth(0.5)
        canvas.line(M, 14 * mm, PAGE_W - M, 14 * mm)
        canvas.restoreState()


story = []
A = story.append

# ---------------------------------------------------------------- cover
A(Spacer(1, 42 * mm))
A(Paragraph('GKUC SiteOps', S['title']))
A(Paragraph('How to use the system, from start to finish', S['sub']))
A(HRFlowable(width='100%', thickness=3, color=GREEN, spaceAfter=16))
A(Paragraph(
    'This guide is written for everyone who uses SiteOps &mdash; site supervisors, store '
    'keepers, the quantity surveying team, the office and management. You do not need to '
    'know anything about computers to follow it. Every section tells you what to click and '
    'what will happen.', S['lead']))
A(Spacer(1, 8))
A(Paragraph(
    'Read the first three sections before you start. After that, read only the section for '
    'the work you do.', S['lead']))
A(Spacer(1, 40 * mm))
A(Paragraph('Prepared for GKUC Construction (Pvt) Ltd', S['cover_small']))
A(Paragraph('Built by Infinity AI', S['cover_small']))
A(PageBreak())

# ---------------------------------------------------------------- contents
story.append(Paragraph('What is in this guide', S['h1']))
contents = [
    ('1', 'What SiteOps is for', 'Why the company uses it'),
    ('2', 'Getting started', 'Signing in and looking after your account'),
    ('3', 'Finding your way around', 'The menu, the bell, the search button'),
    ('4', 'A normal working day', 'What happens, and who does it'),
    ('5', 'Projects and sites', 'Starting a project and keeping it up to date'),
    ('6', 'Bills of quantities', 'Building one in the system, or uploading from Excel'),
    ('7', 'Quotations and invoices', 'Turning a BOQ into a price for the client'),
    ('8', 'Tenders', 'Keeping track of what you have bid for'),
    ('9', 'Materials and the store', 'Stock, orders and what has been lent out'),
    ('10', 'Vehicles and equipment', 'Where they are and when papers expire'),
    ('11', 'People and attendance', 'Who is on site, leave and pay'),
    ('12', 'Money', 'What has been spent and what has come in'),
    ('13', 'Site photographs', 'Proving how a site looked'),
    ('14', 'Messages and alerts', 'WhatsApp, the bell and the sound'),
    ('15', 'Finding old documents', 'Searching inside scanned paperwork'),
    ('16', 'Who is allowed to do what', 'Roles and permissions'),
    ('17', 'Changing the dropdown choices', 'Adding your own categories and types'),
    ('18', 'If something looks wrong', 'Simple things to check first'),
]
story += table([['', 'Section', 'What it covers']] +
               [[n, f'<b>{t}</b>', d] for n, t, d in contents],
               [14 * mm, 62 * mm, 94 * mm])
A(PageBreak())

# ---------------------------------------------------------------- 1
A(Paragraph('1. What SiteOps is for', S['h1']))
A(Paragraph(
    'SiteOps holds the day-to-day running of the company in one place. Before, the same '
    'information sat in different notebooks, spreadsheets and phones. Now everyone works '
    'from the same picture.', S['body']))
A(Paragraph('It keeps track of:', S['body']))
A(bullets([
    'Every project, how far along it is and what it has cost so far',
    'Who is on site each day, and who is on leave',
    'Bills of quantities, quotations and invoices',
    'Tenders you have bid for, and their closing dates',
    'Materials in the store, what has been ordered and what has been lent out',
    'Vehicles and equipment, and when their papers run out',
    'Photographs of each site, from the first day onwards',
    'Every document you upload &mdash; contracts, drawings, scanned paperwork',
]))
A(Paragraph(
    'The system also watches for things that need attention and tells you before they '
    'become a problem &mdash; a tender closing, a vehicle licence expiring, stock running low.',
    S['body']))
A(PageBreak())

# ---------------------------------------------------------------- 2
A(Paragraph('2. Getting started', S['h1']))
A(Paragraph('Signing in', S['h2']))
A(steps([
    'Open your web browser and go to the address the office gave you.',
    'Type your email address and your password.',
    'Click <b>Sign in</b>.',
]))
A(Paragraph(
    'You will see your own name at the top right of the screen. If you see somebody '
    'else&rsquo;s name, sign out and sign in again with your own details.', S['body']))

A(Paragraph('Your password', S['h2']))
A(Paragraph(
    'Your password must be at least 12 characters long and must mix capital letters, small '
    'letters and numbers or symbols. This sounds long, but a short sentence works well &mdash; '
    'something you will remember and nobody else would guess.', S['body']))
A(bullets([
    'Never share your password, not even with a colleague you trust.',
    'Never write it on a note stuck to the screen.',
    'To change it, click your name at the top right and choose <b>My account</b>.',
]))
story += note(
    'The system knows who did what',
    'Everything you do is recorded against your name &mdash; every price changed, every '
    'record approved, every document uploaded. If you let somebody else use your account, '
    'their actions will look like yours.')

A(Paragraph('Signing out', S['h2']))
A(Paragraph(
    'Click your name at the top right and choose <b>Sign out</b>. The system also signs you '
    'out on its own after an hour of doing nothing, so a screen left open in the site office '
    'cannot be used by somebody walking past.', S['body']))
A(PageBreak())

# ---------------------------------------------------------------- 3
A(Paragraph('3. Finding your way around', S['h1']))
A(Paragraph(
    'The menu runs along the top of the screen. On a phone, tap the three lines at the top '
    'left to open it.', S['body']))
story += table([
    ['Menu item', 'What you will find there'],
    ['<b>Dashboard</b>', 'The first screen. A summary of today &mdash; who is on site, what needs attention, how projects are going.'],
    ['<b>Coordination</b>', 'Moving people, vehicles and equipment between sites.'],
    ['<b>Projects</b>', 'Every project, its budget, progress and team.'],
    ['<b>Tasks</b>', 'Jobs given to people, with dates they are due.'],
    ['<b>Quantity Surveying</b>', 'Bills of quantities, quotations, tenders, retention and subcontractors.'],
    ['<b>People</b>', 'Employees, attendance, leave and payroll.'],
    ['<b>Materials</b>', 'Stock in the store, purchase requests and orders.'],
    ['<b>Fleet</b>', 'Vehicles, equipment and their documents.'],
    ['<b>Finance</b>', 'Money spent and money received.'],
    ['<b>Daily reports</b>', 'What happened on site each day.'],
    ['<b>Administration</b>', 'Accounts, permissions and settings. Management only.'],
], [42 * mm, 128 * mm])

A(Paragraph('Three buttons at the top right', S['h2']))
story += table([
    ['Button', 'What it does'],
    ['<b>Magnifying glass</b>', 'Searches <i>inside</i> your documents &mdash; even scanned ones. See section 15.'],
    ['<b>Speaker</b>', 'Turns the alert sound on or off. Your choice is remembered on this device.'],
    ['<b>Bell</b>', 'Shows your alerts. A red dot means something new. A small green dot underneath means the system is live.'],
], [42 * mm, 128 * mm])

story += note(
    'The screen updates by itself',
    'You do not need to refresh the page. When somebody else adds a task, records '
    'attendance or approves a document, your screen changes within a second. If the green '
    'dot under the bell disappears, your internet connection has dropped &mdash; it will '
    'reconnect on its own.', 'tip')
A(PageBreak())

# ---------------------------------------------------------------- 4
A(Paragraph('4. A normal working day', S['h1']))
A(Paragraph(
    'This is the rhythm the system is built around. Not everybody does all of it &mdash; do '
    'the part that belongs to your job.', S['body']))

A(Paragraph('Morning', S['h2']))
story += table([
    ['Who', 'What they do'],
    ['<b>Site supervisor</b>', 'Opens <b>People &rarr; Attendance</b> and marks who has come to site. Anyone arriving after the agreed time is marked late automatically.'],
    ['<b>Store keeper</b>', 'Checks <b>Materials</b> for anything running low and raises a purchase request.'],
    ['<b>Coordinator</b>', 'Looks at the <b>Dashboard</b> to see what needs attention today, and moves people or vehicles between sites if needed.'],
    ['<b>Everyone</b>', 'Checks the bell for alerts.'],
], [38 * mm, 132 * mm])

A(Paragraph('During the day', S['h2']))
story += table([
    ['Who', 'What they do'],
    ['<b>Site supervisor</b>', 'Marks tasks finished as the work is done. Takes photographs of progress and adds them to the project gallery.'],
    ['<b>Store keeper</b>', 'Records materials going out to site, and tools lent to workers.'],
    ['<b>QS team</b>', 'Prepares bills of quantities and quotations. Keeps tender dates up to date.'],
    ['<b>Office</b>', 'Records money received and bills paid.'],
], [38 * mm, 132 * mm])

A(Paragraph('End of the day', S['h2']))
story += table([
    ['Who', 'What they do'],
    ['<b>Site supervisor</b>', 'Writes the daily report: what was done, how many people worked, the weather, and any problem that held work up.'],
    ['<b>Store keeper</b>', 'Marks returned tools as returned.'],
    ['<b>Management</b>', 'Reviews what is waiting for approval.'],
], [38 * mm, 132 * mm])

story += note(
    'Write the daily report the same day',
    'It is the record of what happened on site. If there is a dispute about delays months '
    'later, this report and the site photographs are what settle it. Written a week later '
    'from memory, it is worth very little.')
A(PageBreak())

# ---------------------------------------------------------------- 5
A(Paragraph('5. Projects and sites', S['h1']))
A(Paragraph('Starting a new project', S['h2']))
A(steps([
    'Go to <b>Projects</b> and click <b>Add project</b>.',
    'Fill in the name, the client, where the site is, and the start and finish dates.',
    'Put in the contract value as the budget.',
    'Save. The project now appears on the dashboard.',
]))

A(Paragraph('Keeping it up to date', S['h2']))
A(bullets([
    '<b>Progress</b> &mdash; update the percentage as work moves on. The dashboard uses this.',
    '<b>Team</b> &mdash; add the people working on the site so the system knows where everyone is.',
    '<b>Health</b> &mdash; mark a project <i>At risk</i> as soon as you think it may slip. It is better to raise it early.',
    '<b>Documents</b> &mdash; upload the contract, drawings and approvals against the project.',
]))

A(Paragraph('Moving people between sites', S['h2']))
A(Paragraph(
    'If a site stops &mdash; rain, a hold-up, a permit &mdash; open <b>Coordination</b> and '
    'reschedule it. Choose where the crew should go instead. The system moves the people, '
    'vehicles and equipment across, records that it happened, and tells everyone affected.',
    S['body']))
A(PageBreak())

# ---------------------------------------------------------------- 6  (the new feature)
A(Paragraph('6. Bills of quantities', S['h1']))
A(Paragraph(
    'A bill of quantities &mdash; a BOQ &mdash; is the priced list of work. Everything else '
    'is built from it: the quotation you send the client, the invoices, and the budget the '
    'project is measured against.', S['body']))
A(Paragraph(
    'There are <b>two ways</b> to make one, and both are equally supported. Go to '
    '<b>Quantity Surveying</b> and open the <b>Bills of quantities</b> tab. The two choices '
    'are side by side at the top of the screen.', S['body']))
story += table([
    ['Choose', 'When it suits', 'What happens'],
    ['<b>Build it here</b>', 'A short bill, or when you are pricing as you go.', 'A form opens. Add lines one at a time and save.'],
    ['<b>Bring it in from Excel</b>', 'A long bill, or one already priced in a spreadsheet.', 'Download the template, fill it in, upload it, check it, approve it.'],
], [40 * mm, 62 * mm, 68 * mm])

A(Paragraph('Way 1: build it in the system', S['h2']))
A(steps([
    'Go to <b>Quantity Surveying</b> and open the <b>Bills of quantities</b> tab.',
    'Click <b>Build it here</b>.',
    'Choose the project and give the bill a title.',
    'Add each line of work: the category, what it is, the unit, the quantity and the rate.',
    'Click <b>Add line</b> for each further item. The running total is shown at the bottom.',
    'The system multiplies quantity by rate for you. Do not work out the amounts yourself.',
]))
A(Paragraph(
    'The <b>Category</b> dropdown offers the categories your company uses. If the one you '
    'need is missing, it can be added &mdash; see section 17.', S['body']))

A(Paragraph('Way 2: upload a BOQ you made in Excel', S['h2']))
A(Paragraph(
    'Most estimators are faster in Excel. You can work there and bring the finished BOQ '
    'into the system.', S['body']))
A(steps([
    'On the same screen, click <b>Download the template</b>. This gives you an Excel file with the right columns '
    'and an example row. There is a second sheet called <b>Instructions</b> explaining each column.',
    'Fill it in. One line of work per row.',
    'Come back to the same screen and click <b>Upload a filled-in BOQ</b>.',
    'The system reads your file and shows you everything it found. <b>Nothing is saved yet.</b>',
    'Check the list. Fix anything marked in orange by clicking on it and typing.',
    'Choose the project, then click <b>Approve and create the BOQ</b>.',
]))

story += note(
    'Leave the Amount column empty',
    'The system multiplies quantity by rate itself. If you type an amount that does not '
    'match, it will tell you and use quantity &times; rate. This is deliberate: it means a '
    'typing mistake in one column cannot quietly change a price.', 'tip')

A(Paragraph('What the checking screen shows you', S['h2']))
story += table([
    ['You will see', 'What it means', 'What to do'],
    ['<b>Orange row with a warning</b>', 'The system could not understand something &mdash; a category spelled differently, a quantity that is not a number, a missing rate.', 'Click on the value and correct it. Or untick the row to leave it out.'],
    ['<b>Blue note</b>', 'Something worth knowing, but not a mistake. Usually the amount in your file not matching quantity &times; rate.', 'Nothing. Read it and carry on.'],
    ['<b>Tick box on the left</b>', 'Whether the row will be included.', 'Untick anything you do not want &mdash; headings, blank lines, notes to yourself.'],
], [40 * mm, 66 * mm, 64 * mm])

A(Paragraph(
    'You cannot save until every orange row is either corrected or unticked. This is on '
    'purpose. A BOQ with a line nobody could read becomes a quotation with a wrong price.',
    S['body']))

A(Paragraph('Changing a BOQ after it has been approved', S['h2']))
A(Paragraph(
    'While a BOQ is a <b>draft</b>, you can edit it freely. Once it has been <b>approved</b>, '
    'it is locked &mdash; because quotations, invoices and the project budget are now built '
    'on those figures.', S['body']))
A(steps([
    'Open the BOQ and ask for the change you need, giving the reason.',
    'The Managing Director is told straight away.',
    'Nothing changes until they approve it. If they do, the new figure is applied and the '
    'BOQ total is corrected. If they reject it, nothing changes and you are told why.',
]))
A(Paragraph(
    'The Managing Director can give this approval power to somebody else &mdash; the QS head, '
    'for example &mdash; from <b>Administration &rarr; Access control</b>.', S['body']))
A(PageBreak())

# ---------------------------------------------------------------- 7
A(Paragraph('7. Quotations and invoices', S['h1']))
A(Paragraph(
    'A quotation is built from an approved BOQ. You never retype the prices &mdash; they are '
    'copied across, which is why they always match.', S['body']))
A(steps([
    'Go to <b>Quantity Surveying &rarr; Quotations</b> and click <b>Create quotation</b>.',
    'Choose the BOQ it is based on.',
    'Add your mark-up percentage if you are adding one.',
    'Check the total, then save.',
    'Click <b>PDF</b> to produce the document to send the client.',
]))
A(Paragraph(
    'When the client accepts, mark the quotation <b>Accepted</b>. The system then knows the '
    'work is confirmed and the figures feed into the project.', S['body']))

A(Paragraph('If a subcontractor gives you a price', S['h2']))
A(Paragraph(
    'Record the subcontractor&rsquo;s quotation in the <b>Subcontractors</b> tab. You can then '
    'carry that price into your own quotation with your mark-up added, and the system '
    'remembers where the figure came from. It will also warn you when a subcontractor&rsquo;s '
    'price is about to run out of validity.', S['body']))
A(PageBreak())

# ---------------------------------------------------------------- 8
A(Paragraph('8. Tenders', S['h1']))
A(Paragraph(
    'The tenders section keeps track of everything you have bid for, so nothing is missed '
    'because a date passed unnoticed.', S['body']))
A(bullets([
    'Record the tender: who it is for, the reference, and the closing date and time.',
    'List the documents the tender asks for, and tick them off as they are prepared.',
    'The system counts down to the closing date and warns you as it approaches.',
    'It will not let you mark a tender submitted while required documents are still missing.',
    'When you hear the result, record it. If you won, the tender can become a project.',
]))
A(PageBreak())

# ---------------------------------------------------------------- 9
A(Paragraph('9. Materials and the store', S['h1']))
A(Paragraph('Everyday use', S['h2']))
A(bullets([
    '<b>Receiving materials</b> &mdash; record what arrived, from which supplier, and the cost.',
    '<b>Issuing to site</b> &mdash; record what went out and to which project. The cost goes against that project.',
    '<b>Lending tools</b> &mdash; record who took what, and mark it returned when it comes back.',
]))
A(Paragraph('Ordering', S['h2']))
A(steps([
    'Raise a <b>purchase request</b> saying what is needed and when.',
    'Management approves or rejects it.',
    'Once approved, it becomes a purchase order to the supplier.',
    'When the goods arrive, record the receipt. Stock goes up automatically.',
]))
story += note(
    'Set the minimum level for every material',
    'The system warns you when stock falls below it. Without a minimum level it cannot warn '
    'you, and you find out you are short when the site calls.', 'tip')
A(PageBreak())

# ---------------------------------------------------------------- 10
A(Paragraph('10. Vehicles and equipment', S['h1']))
A(bullets([
    'Record every vehicle with its registration, and every piece of equipment with its code.',
    'Say which project each one is on, so you always know where things are.',
    'Add the expiry dates for insurance, licence, emission test and any other document.',
    'The system warns you before each one runs out. An expired licence stops a lorry, and stops the work it was carrying.',
    'Record services and repairs so a vehicle&rsquo;s history stays with it.',
]))
A(Paragraph(
    'Equipment can carry a printed code that a phone camera can read, so a tool can be '
    'checked in and out quickly on site.', S['body']))
A(PageBreak())

# ---------------------------------------------------------------- 11
A(Paragraph('11. People and attendance', S['h1']))
A(Paragraph('Attendance', S['h2']))
A(Paragraph(
    'Mark attendance every morning. You can enter it by hand, or upload the export file '
    'from a fingerprint machine and the system will read it.', S['body']))
A(bullets([
    'Anyone arriving after the agreed start time is marked late automatically.',
    'Attendance feeds payroll, so getting it right each day saves arguments at month end.',
]))
A(Paragraph('Leave', S['h2']))
A(Paragraph(
    'An employee asks for leave, a manager approves or rejects it, and the system keeps '
    'the balance. Approved leave shows on the attendance screen, so nobody is marked absent '
    'when they were allowed the day off.', S['body']))
A(Paragraph('Pay', S['h2']))
A(Paragraph(
    'Payroll uses the attendance already recorded. Staff on a monthly salary and workers on '
    'a daily rate are both handled. Check the figures before approving a pay run &mdash; once '
    'approved, payslips can be produced.', S['body']))
A(PageBreak())

# ---------------------------------------------------------------- 12
A(Paragraph('12. Money', S['h1']))
A(bullets([
    '<b>Expenses</b> &mdash; every cost recorded against the project it belongs to.',
    '<b>Income</b> &mdash; every payment received, with the date it actually arrived.',
    '<b>Retention</b> &mdash; money the client holds back until the defects period ends. Record the release date and the system will chase it for you.',
]))
A(Paragraph(
    'The dashboard compares what a project has cost against its budget. This only tells the '
    'truth if costs are recorded as they happen, so record them the same week.', S['body']))
story += note(
    'Retention is real money',
    'It is the most commonly forgotten income in construction. Record it with its release '
    'date the moment the contract is signed, and the system will remind you when it is due.')
A(PageBreak())

# ---------------------------------------------------------------- 13
A(Paragraph('13. Site photographs', S['h1']))
A(Paragraph(
    'The gallery is the picture record of a site. On the very first day, before any work '
    'starts, photograph every corner of the plot. That set of photographs is your proof of '
    'how the ground was handed to you.', S['body']))
A(steps([
    'Open the project and go to <b>Gallery</b>.',
    'Make folders for the different parts of the work.',
    'Upload photographs, or take them with the camera on your phone.',
])) 
A(Paragraph(
    'Every photograph is stamped with the date and time it was added. <b>That stamp can '
    'never be changed by anybody, including management.</b> This is what makes the gallery '
    'worth having: a photograph nobody can back-date is evidence.', S['body']))
A(Paragraph(
    'A photograph added by mistake can be withdrawn from view, but the record that it '
    'existed remains. Nothing is ever silently deleted.', S['body']))
A(PageBreak())

# ---------------------------------------------------------------- 14
A(Paragraph('14. Messages and alerts', S['h1']))
A(Paragraph('Alerts inside the system', S['h2']))
A(Paragraph(
    'The bell at the top right shows things that need attention: a tender closing, a licence '
    'expiring, stock running low, a task overdue. A message also slides in at the top right '
    'of your screen when something important happens, with a sound. Turn the sound off with '
    'the speaker button if you are in a meeting.', S['body']))

A(Paragraph('WhatsApp messages', S['h2']))
A(Paragraph(
    'Important alerts can also be sent to people&rsquo;s phones on WhatsApp, so a supervisor '
    'on site hears about them without opening the system.', S['body']))
A(Paragraph('To send a message yourself:', S['body']))
A(steps([
    'Go to <b>Administration &rarr; Messages</b>.',
    'Choose who it goes to. You can pick people one by one, add a whole site team at once, '
    'or type a number for somebody who is not on the system &mdash; a supplier, for example.',
    'Write your message and click <b>Send</b>.',
    'You will see exactly who it reached. Anyone without a phone number on file is shown '
    'as skipped, so you know to follow up another way.',
]))
story += note(
    'Only certain people can send WhatsApp messages',
    'These messages go out under the company&rsquo;s name and cost money for each one. The '
    'Managing Director decides who is allowed, from <b>Administration &rarr; Access control</b>.')
A(PageBreak())

# ---------------------------------------------------------------- 15
A(Paragraph('15. Finding old documents', S['h1']))
A(Paragraph(
    'Click the magnifying glass at the top right and type what you remember. This does not '
    'just search file names &mdash; it searches the words <i>inside</i> your documents.',
    S['body']))
A(Paragraph(
    'When you upload a document, the system reads it in the background. A few seconds later '
    'you can find it by any word it contains: a supplier&rsquo;s name, a reference number, an '
    'amount. This works for scanned paperwork and photographs of documents, as well as '
    'ordinary files.', S['body']))
A(Paragraph('For example, typing a supplier name will find:', S['body']))
A(bullets([
    'A scanned quotation from that supplier from two years ago',
    'A contract that mentions them',
    'A photograph of a delivery note with their name on it',
]))
story += note(
    'Handwriting cannot be read',
    'The system reads printed and typed documents well. It cannot read handwriting. '
    'Handwritten site records are still worth uploading &mdash; they are stored safely and you '
    'can find them by project and date &mdash; but you will not be able to search the words '
    'inside them.')
A(Paragraph(
    'You will only ever see documents you are allowed to see. A search by a store keeper '
    'will never show a payslip or an employment contract.', S['body']))
A(PageBreak())

# ---------------------------------------------------------------- 16
A(Paragraph('16. Who is allowed to do what', S['h1']))
A(Paragraph(
    'Everybody has a role, and each role can do certain things. This is why two people can '
    'look at the same screen and see different buttons.', S['body']))
story += table([
    ['Role', 'What they can do'],
    ['<b>Managing Director</b>', 'Everything, including deciding what everyone else may do.'],
    ['<b>Assistant to the MD</b>', 'Manages user accounts and helps run the system day to day.'],
    ['<b>Project Coordinator</b>', 'Runs projects, moves people and vehicles, sees most things.'],
    ['<b>QS Department Head</b>', 'Bills of quantities, quotations, tenders and retention.'],
    ['<b>Finance Department Head</b>', 'Money in and out, invoices and payments.'],
    ['<b>HR Department Head</b>', 'Employees, leave, attendance and payroll.'],
    ['<b>Transport Department Head</b>', 'Vehicles, equipment and their documents.'],
    ['<b>Site Supervisor</b>', 'Daily reports, tasks, attendance and site photographs.'],
    ['<b>Store Keeper</b>', 'Stock, goods received and tools lent out.'],
    ['<b>Read-Only Viewer</b>', 'Can look, cannot change anything.'],
], [48 * mm, 122 * mm])
A(Paragraph(
    'The Managing Director can change what any role is allowed to do, and can also give one '
    'person an extra permission without changing their whole role. This is done in '
    '<b>Administration &rarr; Access control</b>.', S['body']))
A(Paragraph(
    'If you cannot see something you think you need, ask the Managing Director rather than '
    'borrowing somebody else&rsquo;s login.', S['body']))
A(PageBreak())

# ---------------------------------------------------------------- 17
A(Paragraph('17. Changing the dropdown choices', S['h1']))
A(Paragraph(
    'Many forms ask you to choose from a list &mdash; the category of a BOQ line, the type '
    'of leave, which paper on a vehicle is expiring. Those lists belong to the company, not '
    'to the software, and they can be changed without anybody touching the system.',
    S['body']))
A(Paragraph('Where to find them', S['h2']))
A(steps([
    'Go to <b>Administration</b> and open the <b>Lists</b> tab.',
    'The lists are grouped by department, so the ones you want are together.',
    'Click <b>Add</b> beside a list to add a choice, type the name, and press Enter.',
]))
A(Paragraph('What you can do to a choice', S['h2']))
story += table([
    ['Action', 'What it does'],
    ['<b>Rename</b> (pencil)', 'Changes the wording everywhere, including on records that already use it. A report on last year still reads correctly.'],
    ['<b>Turn off</b> (crossed eye)', 'Stops it being offered on new records. Anything already using it is untouched. Use this rather than deleting.'],
    ['<b>Delete</b> (bin)', 'Only offered for choices your company added, and only while nothing uses them.'],
], [44 * mm, 126 * mm])

A(Paragraph(
    'A change takes effect immediately. Somebody with a form already open on another screen '
    'will see the new choice appear without reloading anything.', S['body']))

story += note(
    'Some choices have a padlock',
    'A very small number of words are read by the system to decide what to do. <b>Unpaid</b> '
    'leave is the example: payroll finds unpaid days by looking for that exact word, so '
    'renaming it would quietly stop the deduction. Those are marked with a padlock and can '
    'be reordered but not renamed or turned off.')

A(Paragraph('What is not on this screen', S['h2']))
A(Paragraph(
    'Words like <b>Draft</b>, <b>Approved</b>, <b>Pending</b> and <b>Completed</b> are not '
    'there, and that is deliberate. They are not labels &mdash; the system reads them to '
    'decide what happens next. An invoice that is Approved can be paid. A BOQ that is '
    'Approved locks and needs permission to change. A tender that is Submitted stops warning '
    'you about its closing date.', S['body']))
A(Paragraph(
    'A status somebody invented would be a word nothing in the system knows how to act on, '
    'and the record would sit in a state nobody could move it out of. If you need a new '
    'stage in a workflow, that is a change to the system itself &mdash; ask the office.',
    S['body']))
A(PageBreak())

A(Paragraph('18. If something looks wrong', S['h1']))
story += table([
    ['What you see', 'What to do'],
    ['<b>The screen is not updating</b>', 'Look under the bell for the small green dot. No dot means your internet has dropped. It reconnects on its own; if it does not, refresh the page.'],
    ['<b>A button is missing</b>', 'Your role does not allow that action. Ask the Managing Director.'],
    ['<b>&ldquo;Session expired&rdquo;</b>', 'You were signed out after an hour of inactivity. Sign in again.'],
    ['<b>A file will not upload</b>', 'Check the file type. The system takes photographs, PDFs, Word and Excel files. It does not take programs or compressed files.'],
    ['<b>A search finds nothing</b>', 'Try a different word. Remember that handwriting cannot be read. Very new uploads take a few seconds to become searchable.'],
    ['<b>A choice is missing from a dropdown</b>', 'It can probably be added. See section 17, or ask somebody with Administration access.'],
    ['<b>A figure looks wrong</b>', 'Do not correct it by working around it. Find where it was entered and fix it there, so every screen agrees.'],
], [46 * mm, 124 * mm])

A(Paragraph('Two habits worth keeping', S['h2']))
A(bullets([
    '<b>Record things as they happen</b>, not at the end of the week. The system is only as '
    'good as what is put into it, and memory is not a reliable source.',
    '<b>If something looks wrong, say so.</b> A wrong figure that nobody mentions ends up in '
    'a quotation, an invoice, or a payslip.',
]))
A(Spacer(1, 10))
A(HRFlowable(width='100%', thickness=1, color=LINE, spaceAfter=12))
A(Paragraph(
    'For help with the system, contact the office. For changes to what you are allowed to '
    'do, contact the Managing Director.', S['cover_small']))

doc = Guide('/Users/thinuladamsith/Desktop/gkuc-construction/docs/SiteOps-User-Guide.pdf')
doc.build(story)
print('built')
