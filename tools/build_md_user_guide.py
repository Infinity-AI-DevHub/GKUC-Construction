"""Build the GKUC SiteOps Managing Director user guide from reviewed UI labels."""
from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    BaseDocTemplate, Frame, KeepTogether, NextPageTemplate, PageBreak,
    PageTemplate, Paragraph, Spacer, Table, TableStyle,
)

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "output/pdf/gkuc-siteops-managing-director-user-guide.pdf"
OUT.parent.mkdir(parents=True, exist_ok=True)

NAVY = colors.HexColor("#102641")
RED = colors.HexColor("#981B36")
BLUE = colors.HexColor("#235783")
INK = colors.HexColor("#233449")
MUTED = colors.HexColor("#5B6B7D")
PALE = colors.HexColor("#F2F5F9")
BORDER = colors.HexColor("#D8E1EB")
WHITE = colors.white

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name="TitleGK", fontName="Helvetica-Bold", fontSize=30, leading=34, textColor=WHITE, spaceAfter=14))
styles.add(ParagraphStyle(name="DeckGK", fontName="Helvetica", fontSize=12, leading=18, textColor=WHITE))
styles.add(ParagraphStyle(name="H1GK", fontName="Helvetica-Bold", fontSize=17, leading=21, textColor=NAVY, spaceBefore=4, spaceAfter=8))
styles.add(ParagraphStyle(name="H2GK", fontName="Helvetica-Bold", fontSize=11.2, leading=15, textColor=NAVY, spaceBefore=10, spaceAfter=5, keepWithNext=True))
styles.add(ParagraphStyle(name="BodyGK", fontName="Helvetica", fontSize=9.05, leading=13.5, textColor=INK, spaceAfter=5))
styles.add(ParagraphStyle(name="SmallGK", fontName="Helvetica", fontSize=8.2, leading=11.5, textColor=INK, spaceAfter=3))
styles.add(ParagraphStyle(name="MutedGK", fontName="Helvetica", fontSize=8.2, leading=11.5, textColor=MUTED, spaceAfter=5))
styles.add(ParagraphStyle(name="LabelGK", fontName="Helvetica-Bold", fontSize=7.3, leading=10, textColor=RED, spaceAfter=2))
styles.add(ParagraphStyle(name="TableHeadGK", fontName="Helvetica-Bold", fontSize=8, leading=11, textColor=WHITE))
styles.add(ParagraphStyle(name="TableGK", fontName="Helvetica", fontSize=8, leading=11, textColor=INK))


def p(text, style="BodyGK"):
    return Paragraph(escape(str(text)).replace("\n", "<br/>"), styles[style])


def rich(text, style="BodyGK"):
    return Paragraph(text, styles[style])


def footer(canvas, doc):
    canvas.saveState()
    w, h = A4
    canvas.setFillColor(NAVY)
    canvas.rect(0, h - 12 * mm, w, 12 * mm, fill=1, stroke=0)
    canvas.setFillColor(RED)
    canvas.rect(0, h - 12 * mm, 27 * mm, 12 * mm, fill=1, stroke=0)
    canvas.setFont("Helvetica-Bold", 8)
    canvas.setFillColor(WHITE)
    canvas.drawString(31 * mm, h - 8 * mm, "GKUC SITEOPS  /  MANAGING DIRECTOR GUIDE")
    canvas.setStrokeColor(BORDER)
    canvas.line(17 * mm, 16 * mm, w - 17 * mm, 16 * mm)
    canvas.setFillColor(MUTED)
    canvas.setFont("Helvetica", 7.5)
    canvas.drawString(17 * mm, 11 * mm, "Operational guide based on the application UI - 17 September 2026")
    canvas.drawRightString(w - 17 * mm, 11 * mm, str(doc.page))
    canvas.restoreState()


class GuideDoc(BaseDocTemplate):
    def __init__(self, filename):
        super().__init__(str(filename), pagesize=A4, leftMargin=17*mm, rightMargin=17*mm,
                         topMargin=20*mm, bottomMargin=20*mm, title="GKUC SiteOps - Managing Director User Guide",
                         author="GKUC SiteOps")
        frame = Frame(self.leftMargin, self.bottomMargin, self.width, self.height, id="normal", leftPadding=0,
                      rightPadding=0, topPadding=0, bottomPadding=0)
        self.addPageTemplates(PageTemplate(id="body", frames=frame, onPage=footer))


story = []


def section(number, title, intro):
    story.append(Spacer(1, 7 * mm))
    story.append(p(f"{number:02d}  {title}", "H1GK"))
    story.append(p(intro))
    story.append(Spacer(1, 1 * mm))


def scenario(title, path, steps, fields=None, result=None, caution=None):
    content = [p(title, "H2GK")]
    content.append(rich(f'<font color="#981B36"><b>GO TO</b></font>  {escape(path)}', "SmallGK"))
    for i, step in enumerate(steps, 1):
        content.append(rich(f'<font color="#981B36"><b>{i}.</b></font>  {escape(step)}', "SmallGK"))
    if fields:
        content.append(rich(f'<font color="#981B36"><b>ENTER / CHECK</b></font>  {escape(fields)}', "SmallGK"))
    if result:
        content.append(rich(f'<font color="#235783"><b>AFTER SAVING</b></font>  {escape(result)}', "SmallGK"))
    if caution:
        content.append(rich(f'<font color="#981B36"><b>DO NOT DUPLICATE</b></font>  {escape(caution)}', "SmallGK"))
    story.append(KeepTogether(content))
    story.append(Spacer(1, 2 * mm))


def note(title, text):
    t = Table([[rich(f'<b>{escape(title)}</b>', "SmallGK"), p(text, "SmallGK")]], colWidths=[31*mm, 145*mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0,0),(-1,-1), PALE), ("LINEBEFORE",(0,0),(0,-1),3,RED),
        ("BOX",(0,0),(-1,-1),0.5,BORDER), ("VALIGN",(0,0),(-1,-1),"TOP"),
        ("LEFTPADDING",(0,0),(-1,-1),8), ("RIGHTPADDING",(0,0),(-1,-1),8),
        ("TOPPADDING",(0,0),(-1,-1),8), ("BOTTOMPADDING",(0,0),(-1,-1),8),
    ]))
    story.append(KeepTogether([t, Spacer(1, 3*mm)]))


def list_block(title, items):
    story.append(p(title, "H2GK"))
    for item in items:
        story.append(rich(f'<font color="#981B36"><b>•</b></font>  {escape(item)}', "SmallGK"))
    story.append(Spacer(1, 2*mm))


def report_grid(title, items):
    story.append(p(title, "H2GK"))
    midpoint = (len(items) + 1) // 2
    left, right = items[:midpoint], items[midpoint:]
    rows = []
    for i in range(midpoint):
        a = f"{i+1:02d}  {left[i]}"
        b = f"{midpoint+i+1:02d}  {right[i]}" if i < len(right) else ""
        rows.append([p(a, "TableGK"), p(b, "TableGK")])
    grid = Table(rows, colWidths=[88*mm,88*mm], hAlign="LEFT")
    grid.setStyle(TableStyle([
        ("ROWBACKGROUNDS",(0,0),(-1,-1),[WHITE,PALE]), ("LINEBELOW",(0,0),(-1,-1),0.3,BORDER),
        ("VALIGN",(0,0),(-1,-1),"TOP"), ("LEFTPADDING",(0,0),(-1,-1),6),
        ("RIGHTPADDING",(0,0),(-1,-1),6), ("TOPPADDING",(0,0),(-1,-1),5),
        ("BOTTOMPADDING",(0,0),(-1,-1),5),
    ]))
    story.append(grid)
    story.append(Spacer(1, 3*mm))


# Cover
cover = Table([[rich("GKUC", "TitleGK")], [rich("SITEOPS", "TitleGK")],
               [rich("Managing Director\'s complete user guide", "DeckGK")],
               [rich("Scenario-based instructions for every operating area", "DeckGK")]], colWidths=[176*mm])
cover.setStyle(TableStyle([
    ("BACKGROUND",(0,0),(-1,-1),NAVY), ("LINEBEFORE",(0,0),(0,-1),8,RED),
    ("LEFTPADDING",(0,0),(-1,-1),18), ("RIGHTPADDING",(0,0),(-1,-1),18),
    ("TOPPADDING",(0,0),(-1,0),26), ("BOTTOMPADDING",(0,0),(-1,0),2),
    ("TOPPADDING",(0,1),(-1,1),0), ("BOTTOMPADDING",(0,1),(-1,1),18),
    ("TOPPADDING",(0,2),(-1,-1),3), ("BOTTOMPADDING",(0,-1),(-1,-1),26),
]))
story += [Spacer(1, 48*mm), cover, Spacer(1, 16*mm),
          p("For the Managing Director account. This role can use all modules and approve all workflows.", "BodyGK"),
          p("Use this guide in the order a construction business works: set up the company, win and create a project, plan and purchase, run the site, pay people, settle finances, then review reports and controls.", "BodyGK"),
          p("Version: 17 September 2026. Screens and labels reflect the current GKUC SiteOps application.", "MutedGK"), PageBreak()]

section(0, "How to use this guide", "Each scenario starts with the navigation path, then the action, the information to enter, and the outcome to check. Asterisk-marked fields on screen are required. Use Save, Create, Record, Submit or Issue only after reviewing the selected company and project.")
note("Important", "GKUC Construction and GKUC Readymix share people, materials and vehicles. Projects, quotations, BOQs, invoices and financial totals are company-specific. Check the Operating company selector before commercial or finance work.")
note("One source", "Enter a transaction in its source workflow once. For example, receive a client cheque in Cheques, issue stock in Materials or Stock locations, and enter a supplier invoice in Supplier invoices. Do not add a second manual Finance entry for the same event.")
list_block("Contents", [
    "01 Getting in and navigating", "02 Initial company and administration setup", "03 New business and project creation",
    "04 Running a project and coordinating sites", "05 BOQs, quotations, tenders and QS control",
    "06 Materials, purchasing and stock locations", "07 Fleet and equipment", "08 People and attendance",
    "09 Payroll and performance", "10 Finance, receivables and payables", "11 Daily reports and analytics",
    "12 Communication, files and governance", "13 Operating checklists and troubleshooting",
    "14 Report directory", "15 Screen and feature map",
])

section(1, "Getting in and navigating", "The top navigation exposes all modules. On a narrow screen, overflowed modules are in More. Browser back and direct page links work for main sections.")
scenario("Sign in", "Sign in page", ["Enter your company email address and password.", "Select Sign in. The Dashboard opens after authentication."],
         "Use only your own account. In production, ask an administrator for a temporary password if you do not have one.",
         "The top bar shows your initials, search, alert bell and sound control.")
scenario("Find a section or switch company", "Top navigation / More; Operating company selector", [
    "Choose a visible module, or open More for Stock locations, Fleet, Finance, Daily reports, Chat, Drive, Reports or Administration.",
    "Where the Operating company control appears, choose GKUC Construction or GKUC Readymix before entering commercial data.",
    "Return to Dashboard for the combined operational overview."],
    result="The active company name is displayed above company-scoped pages; shared staff, materials and vehicles remain available.")
scenario("Find a document, alert or account setting", "Top bar / Administration", [
    "Use Search inside documents to find stored files.", "Open the bell for alerts and visit Administration > Notifications for the full queue.",
    "Open your initials menu for account actions; use Administration > My account to change your password."],
    result="Unread alerts can be reviewed or marked read. Alert sound can be turned on or off independently.")

section(2, "Initial company and administration setup", "Do these tasks before the first real quotation, invoice or payroll run. The MD may create other users and delegate access, but this guide assumes the MD performs the actions.")
scenario("Set each company's legal and payment details", "Administration > Company", [
    "Select the correct operating company.", "Update its registered name, telephone, email, VAT rate, TIN, VAT registration, address and bank details.",
    "Save, then switch company and repeat for the other entity."], result="Commercial documents use the company details belonging to the selected entity.")
scenario("Set standard document wording and appearance", "Administration > Documents; Administration > Designer", [
    "In Documents, review the standing quotation, BOQ and invoice terms and any extra footer line.",
    "In Designer, adjust the document design and preview the result before saving.",
    "Create a sample draft document and inspect the printable output."],
    result="Document-specific wording entered later can override the standing terms without changing every other document.")
scenario("Add a user and manage access", "Administration > Users; Administration > Access control", [
    "Select Add user, enter full name, email, temporary password of at least 10 characters, and role.",
    "Use Access control to review or change role permissions and individual grants; deactivate an account in Users when access must stop.",
    "Ask the person to sign in and change the temporary password."],
    caution="Do not create two accounts for the same employee merely to grant access to two companies. Company resources are shared.")
scenario("Maintain business dropdowns", "Administration > Lists", [
    "Choose the list, such as expense types, payment methods or BOQ categories.",
    "Add or edit a choice, then save and confirm that it appears in the relevant form.",
    "Do not rename a locked system choice. Its exact value is used by business rules."],
    result="Configured options become available in forms without deploying new code.")
scenario("Review alerts, audit and fraud signals", "Administration > Notifications / Fraud watch / Audit log", [
    "Review unread alerts and use Run deadline scan to refresh deadlines and exceptions.",
    "Use Fraud watch for flagged activity, then inspect Audit log for who changed a record and when.",
    "Mark reviewed alerts read; resolve or dismiss fraud-watch findings only after checking evidence."],
    result="The bell count updates with the notification centre.")
scenario("Preview the evening summary and messages", "Administration > Evening summary / Messages", [
    "Read the evening message preview before sending.",
    "Use Send it now only when a manual summary is needed; recipients require a WhatsApp number on their account.",
    "Use Messages for direct operational communication."],
    caution="Sending the summary or a message contacts people. Confirm the contents and recipients first.")

section(3, "New business and project creation", "A project should be registered once, under the correct company. If it began as an inquiry, convert that inquiry instead of creating an unrelated second project.")
scenario("Record and progress a customer inquiry", "Projects > Inquiries", [
    "Select Log customer inquiry and enter customer, contact, phone, email, location, expected value, likely start, source and what the customer wants.",
    "Save and update its stage as discussions continue: New, In discussion, Quoted, Won or Lost.",
    "When won, use Register project on that inquiry."],
    result="The new project retains its relationship to the originating inquiry.",
    caution="Do not also use Create project for the same won inquiry.")
scenario("Create a project directly", "Projects > Projects > Create project", [
    "Check the Operating company first.", "Select Create project.",
    "Enter Project name, Client, Project manager, Site location, Current stage, Opening budget, Start date and Target completion.",
    "Save, then open the project card to review its detail page."],
    result="The new project becomes available to tasks, BOQs, purchases, attendance, stock, fleet, daily reports and company-scoped finance.")
scenario("Review the complete project record", "Projects > Projects > select a project", [
    "Use Command centre for health, budget, work queue and daily intelligence.",
    "Open Activity & issues, Reports, Programme, Commercial, Subcontractors, Team, Gallery, Documents and Close-out for the respective workstream.",
    "Use Back to projects when finished."],
    result="These tabs show linked records; most do not require a second copy of the underlying transaction.")
scenario("Build the project programme and task plan", "Project detail > Programme; Tasks", [
    "Add a milestone with title, due date and status; advance it as work progresses.",
    "Create a task with title, project, assignee, deadline, priority and notes.",
    "Review Task history, attach site photos/files, and move tasks through their statuses to completion and approval."],
    result="The project command centre and task productivity report reflect the new work.")
scenario("Log a site issue or update", "Project detail > Activity & issues > Add update or issue", [
    "Choose type, headline, details, category, status, priority, responsible person and follow-up date.",
    "Save, then create a task if somebody must perform a specific follow-up action.",
    "Use this for material delays, access problems, design changes and site decisions."],
    result="The issue appears in the project activity timeline; a task is separately assignable and trackable.")
scenario("Assign project people, organize photos and close out", "Project detail > Team / Gallery / Documents / Close-out", [
    "In Team, assign an employee and their role on the project.",
    "In Gallery, upload evidence to the appropriate folder and add descriptions/checklists where available.",
    "In Documents, review project files; use Close-out to inspect completion requirements before closing work."],
    caution="Store photos and files against the project, not in unrelated chat messages only.")

section(4, "Running a project and coordinating sites", "The Coordination module is the cross-project control desk. Use it to see resource availability before reassigning people, tools or vehicles.")
scenario("See what is happening today", "Coordination > Live sites", [
    "Review each active site, people on site, vehicles out and tools out.",
    "Open a site to see its current assignment and schedule.",
    "If a site is delayed, use Reschedule and enter new status, effective date, destination and reason."],
    result="The movement is recorded and affected people can be notified.")
scenario("Find free resources for a chosen date", "Coordination > Resource availability; People > Workforce map", [
    "Choose the date in the availability view.",
    "Check free labour, vehicles, tools and site allocations; in Workforce map filter everyone, at sites, at office, free or on leave.",
    "Open the person or resource before assigning it to confirm status."],
    caution="Office employees can work at the office or a site; site workers should be shown at a site or unassigned, and leave must be respected.")
scenario("Move a resource and inspect the trail", "Coordination > Live sites / Movement history", [
    "Open the resource and select Move.", "Choose the destination and give a reason, then save.",
    "Open Movement history to verify the old and new assignment."],
    result="The cross-site move is visible to other operational modules.")
scenario("Review prospective work", "Coordination > Enquiries", [
    "Open an enquiry to read customer details and the history with that client.",
    "Keep discussions and conversion decisions tied to the same enquiry record."],
    caution="Use Projects > Inquiries to register a won enquiry as a project, rather than making a parallel record.")

section(5, "BOQs, quotations, tenders and QS control", "The QS workflow establishes expected cost, client price, approved changes, actual cost and forecast. Set the correct company and project before building any commercial document.")
scenario("Create or import a BOQ", "Projects > BOQ & estimates > Create BOQ; Quantity Surveying > Bills of quantities", [
    "Create a BOQ for the project and enter its title, work lines, category, unit, quantity and rate.",
    "Use the BOQ import action when a compatible prepared sheet is available; inspect imported items before approval.",
    "Edit wording, notes and terms, open the printable bill, then approve when the estimate is agreed."],
    result="An approved BOQ becomes part of the project's budget basis and can price a quotation.",
    caution="Do not re-enter the same BOQ as another package unless it truly represents separate work.")
scenario("Price a client quotation", "Quantity Surveying > Quotations > Create quotation from a BOQ", [
    "Choose the approved BOQ; confirm client, title, quotation date and valid-until date.",
    "Set markup and VAT percentages, add notes, and build the quotation.",
    "Review the client-ready document, edit wording if necessary, and mark the commercial outcome."],
    result="The quotation reuses BOQ items instead of requiring the same lines to be typed again.")
scenario("Approve a scope or budget change", "Projects > Variations", [
    "Record the variation against the right project and describe the changed scope and value.",
    "Review whether it is pending, approved or rejected; approve only after authorization.",
    "Check the project budget and QS cost forecast after approval."],
    result="Approved changes adjust the current approved budget; unapproved changes remain visible separately.")
scenario("Record an actual daily cost against a BOQ item", "Quantity Surveying > Cost control > Record daily project cost", [
    "Select project, date, cost category, description and the appropriate BOQ item when it was planned.",
    "Enter actual quantity, unit and rate, or the total amount, with the receipt/invoice reference.",
    "Classify the cost as Expected, Variation or Unexpected and save."],
    result="The one shared project cost ledger updates actual spend, item variance and finance reports.",
    caution="If the cost was posted by stock issue, supplier/operating bill, petty cash or fleet, do not record it manually a second time.")
scenario("Forecast an item overrun", "Quantity Surveying > Cost control > select item > Update final-cost forecast", [
    "Compare the item's expected amount with actual to date.",
    "Enter forecast final quantity, unit rate or amount and a reason for the change.",
    "Review the forecast variance and unexpected/unallocated cost sections."],
    result="The project cost forecast and overrun reports show the exposure before the final invoice arrives.")
scenario("Track a tender from discovery to outcome", "Quantity Surveying > Tenders", [
    "Select Track tender and enter works, employer, contract number, bidding entity, procurement method, specialty and grade.",
    "Set document sale dates, fee, bid deadline/time, validity, security, ceiling and estimate.",
    "Use Bid, Documents required and Outcome tabs to update submission, opening and Won/Lost/Withdrawn status."],
    result="The tender record keeps deadline and decision history, including award value and awarded party.")
scenario("Manage retentions and subcontractors", "Quantity Surveying > Retention / Subcontractors", [
    "Record retention with project, amount, percent, held-from and release dates; release only the amount actually returned.",
    "Add a subcontractor's company/individual identity, trade, contact, address and registration/NIC.",
    "Record their quotation, agree a project-specific work-item rate and enter their bill when work is certified."],
    result="Agreed rates and bills remain linked to the project and feed commercial cost views.",
    caution="Do not manually add a second expense for a subcontractor bill that already posts to the project ledger.")

section(6, "Materials, purchasing and stock locations", "Materials covers the purchasing trail and stock transactions. Stock locations explains where quantities and returnable tools are now held.")
scenario("Create the material and supplier masters", "Materials > Stock / Suppliers", [
    "Use Add material for a unique material name, unit, stock type, store, opening stock, minimum level and unit cost.",
    "Use Add supplier for company name, contact, phone, email and address.",
    "Review existing records first to avoid duplicate names or assets."],
    result="The material becomes selectable on requests, orders and stock movements.")
scenario("Request, approve and order stock", "Materials > Purchase requests / Orders", [
    "Raise a purchase request for the project, needed-by date, items, quantities, expected rates and justification.",
    "Collect supplier quotations on the request and compare amount, lead time and notes.",
    "Create a purchase order with supplier, project, order date, quantities and agreed rates."],
    result="The order becomes a procurement commitment; it is not the same as a physical receipt or an invoice.")
scenario("Receive an order and record a supplier invoice", "Materials > Orders; Finance > Supplier invoices", [
    "Open the order, record each delivered quantity against its order line and confirm receipt.",
    "Check that stock increased in Materials and Stock locations.",
    "When the supplier invoice arrives, enter supplier, invoice number, amount, invoice date, due date and related order in Finance."],
    caution="For stock items, the cost posts when stock is issued to a project; do not also make a manual project expense for the receipt.")
scenario("Issue, return or adjust consumable stock", "Materials > Stock > Record stock movement", [
    "Choose material, movement type, quantity and project/site where applicable.",
    "Add the actual delivery/return reference and note, then save.",
    "Confirm stock movement history and site position after saving."],
    result="An issue transfers material to the site and may post its project cost. A return restores quantity; review cost treatment before reporting the final project cost.")
scenario("See stock by place, not just by total", "Stock locations > Locations", [
    "Review storeroom and site positions, vehicle/equipment locations and quantity exceptions.",
    "Use project and material filters to identify what is available and what has been issued.",
    "If a count differs, record a physical site count with counter, condition and variance reason."],
    result="The location view separates store availability from quantities at work sites.")
scenario("Hand over and return a tool", "Stock locations > Tool handovers", [
    "Select Hand over a returnable tool, choose tool, site and quantity.",
    "Record who took it, who handed it over, condition and handover reference.",
    "On return, select the open loan and enter received-by, return reference and condition."],
    result="The open custody record closes and the tool's location changes.",
    caution="Do not record the same handover again as a separate consumable stock issue.")
scenario("Record site consumption and compare with BOQ", "Stock locations > BOQ usage", [
    "Choose the material, project site, quantity used, date and completed work/notes.",
    "Review actual usage against the quoted or BOQ allowance and inspect exception flags.",
    "Investigate overuse with QS before ordering further material."],
    result="The site usage view shows whether material consumption is approaching or exceeding the estimate.")

section(7, "Fleet and equipment", "Vehicles and equipment are shared resources. The asset record holds current assignment plus dated histories for drivers, odometer, fuel, service, repairs and renewals.")
scenario("Add a vehicle and assign a driver", "Fleet > Vehicles > Add asset; open asset > Change driver", [
    "Enter vehicle/equipment name, registration or asset ID, status, site, odometer, service interval and first renewal due date.",
    "Open the asset, choose Change driver, select registered driver or enter a name, site, effective date and note.",
    "Check Driver assignment history for the current and previous driver."],
    caution="Do not overwrite historical assignments to represent a new driver. Use Change driver.")
scenario("Record fuel, odometer and service work", "Fleet > Vehicles > open asset", [
    "Use Odometer for a dated reading and source note.",
    "Use Fuel for date, litres, cost, odometer and project if the fuel belongs to a site.",
    "Use Service or repair for work type, date, odometer, cost, garage, project, status and work carried out; update Service schedule when intervals change."],
    result="The asset history updates. Project-charged fuel or maintenance can flow into project cost reporting.",
    caution="Do not also record the same fleet charge as a manual Finance expense.")
scenario("Manage insurance and revenue-licence renewals", "Fleet > Compliance / Vehicles > open asset > Renewal", [
    "Review renewals due and overdue.",
    "Record document type, reference/policy number, renewed-on, expiry and cost.",
    "Confirm the new expiry appears in Compliance and the asset's Renewal history."],
    result="Deadline alerts can remind the team before the next expiry.")
scenario("Manage registered equipment", "Fleet > Equipment", [
    "Add equipment with asset code, name, category, purchase date, cost and notes.",
    "Assign it to a project and responsible person with issue date, due-back date and condition.",
    "On return, enter date, condition, destination/status and notes; log maintenance or repairs when needed."],
    result="The equipment record retains assignment and maintenance history, and a QR label can open the asset record.",
    caution="Check Stock locations before also creating the same physical tool as a returnable stock item.")

section(8, "People, presence and attendance", "Keep one employee profile per person. HR can add employees manually or discover them in a biometric import. Attendance and leave drive availability and may feed payroll.")
scenario("Add an office employee or site worker", "People > Employees > Add employee", [
    "Enter employee code, full name, department, designation/trade, employee type, contact details and join date.",
    "Choose the paying company, pay basis and payment frequency; configure detailed compensation in Payroll settings.",
    "Open the new employee profile and verify the personal and work details."],
    caution="Search the employee register and biometric queue before creating a second record for the same person.")
scenario("Review the whole employee profile", "People > Employees > select a person", [
    "Read personal details, attendance trend across employment, leave/overtime, project assignments, tasks, work and performance.",
    "Use employee documents for supporting files.",
    "Return to Employees after checking the record."],
    result="This profile is the central record rather than a separate form for every activity.")
scenario("Record attendance for somebody who went directly to site", "People > Attendance > Record attendance", [
    "Choose person, work date, status and project/site, then check-in and check-out times where known.",
    "Save. If an existing record is wrong, use Correct this record and enter a reason rather than making another attendance row.",
    "Review the Attendance register and the person's profile."],
    result="One attendance record per employee per day is maintained, with correction history.")
scenario("Import biometric scanner data", "People > Biometric import", [
    "Upload the scanner report and inspect the preview of days, matched staff, unmatched people and rows needing review.",
    "For each unfamiliar scanner identity, decide whether it is an existing employee, a duplicate identity or a genuinely new person.",
    "Link or correct duplicates; create the person only if genuinely new; then commit reviewed attendance."],
    result="Future imports can recognize linked people without repeating the matching decision.",
    caution="Do not bulk-create all unmatched names without checking duplicates and spelling variants.")
scenario("Check who is working or free", "People > Workforce map / Attendance register / Leave register", [
    "Select the desired day and filter everyone, at sites, at office, free or on leave.",
    "Open individual records if assignment or attendance is unclear.",
    "Use the view with Coordination > Resource availability before assigning people to another site."],
    result="Office and site workers, unassigned people and approved leave are distinguishable.")
scenario("Record leave and overtime", "People > Leave / Overtime", [
    "Record the employee, leave type, dates and reason; approve or reject after review.",
    "Record overtime against the employee, date, project when applicable, hours and correct overtime type.",
    "Approve overtime before running the relevant payroll period."],
    result="Approved leave affects availability and approved overtime can enter the salary calculation.")

section(9, "Payroll and performance", "Payroll has effective-dated policy, employee-specific compensation, recurring components and draft runs. It supports daily, weekly and monthly pay arrangements.")
scenario("Set the general payroll policy", "People > Payroll settings > Add future policy", [
    "Choose an effective-from date.",
    "Enter office, labour site/travel, driver and supervisor site/travel overtime rates.",
    "Enter EPF employee, EPF employer and ETF employer rates and choose their calculation basis."],
    result="New runs use the applicable policy for their period. Historical runs retain their calculated breakdown.")
scenario("Configure an individual salary", "People > Payroll settings > Configure employee", [
    "Choose Salary paid by, pay basis, payment frequency and payroll category.",
    "Enter effective-from date and the relevant monthly basic, weekly rate or daily rate.",
    "Set EPF and ETF eligibility individually; add custom overtime rates only where an exception is required."],
    caution="Do not assume all workers share EPF/ETF eligibility or a monthly salary.")
scenario("Add benefits, allowances or deductions", "People > Payroll settings > Add component", [
    "Choose the employee and component name.",
    "Choose Allowance, Deduction or Reimbursement, enter amount per pay cycle, frequency and effective dates.",
    "Review the employee's active components before a new payroll run."],
    result="The salary sheet shows recurring components separately from base pay and overtime.")
scenario("Give and recover a worker salary advance", "Finance > Petty cash > Salary advance; People > Payroll", [
    "Use the Salary advance float, record Spend, choose the actual employee and enter date, amount and reason.",
    "Do not use the Office expenses or Fuel float for this payment.",
    "After payroll is built, open the salary sheet and check the advance recovery schedule and deduction."],
    result="The advance remains employee-linked and is deducted according to the payroll calculation.")
scenario("Run, inspect, approve and pay payroll", "People > Payroll > Run payroll", [
    "Select period from/to and the employees to pay; build a draft run.",
    "Open it and check basic earnings, attendance, approved overtime, recurring components, EPF/ETF, advances, employer cost and net pay.",
    "Correct underlying attendance or settings if wrong; approve the run, then Mark paid only after payment."],
    caution="Do not create multiple runs for the same people and same period to fix a source mistake.")
scenario("Record a performance review", "People > Performance > Add review", [
    "Choose employee and review period/date.",
    "Score work quality, productivity, safety and reliability; enter strengths and improvement areas.",
    "Save and inspect the review from Performance and the employee profile."],
    result="Management can compare performance with attendance and assigned work.")

section(10, "Finance, receivables and payables", "Finance separates company ledgers while sharing the project and source records that created them. Check the selected company before every bill, invoice, cheque, bond or report.")
scenario("Read financial performance", "Finance > Financial reports / Budget monitoring", [
    "Choose all projects or one project and, where offered, a date range.",
    "Read the narrative, KPIs, chart and supporting table together; export the visible table if needed.",
    "Check Budget monitoring for approved budget, cost, income, payables and variance."],
    result="Project-specific and company-wide views can be compared without re-entering transactions.")
scenario("Record and pay an electricity, water or other bill", "Finance > Bills", [
    "Select Record an operating bill and enter bill type, provider, bill number, account, office/project allocation, period, bill and due dates.",
    "Enter pre-VAT amount, VAT treatment/rate, reminder days and notes.",
    "When actually paid, open the bill and Mark paid with date, method and payment reference."],
    result="Paid project bills post to project cost once and eligible VAT appears in the VAT ledger.",
    caution="Do not also enter the same paid bill under Expenses.")
scenario("Track a company credit card", "Finance > Credit cards", [
    "Add the card name, bank, last four digits, cardholder, limit and default reminder lead time.",
    "For each period, Record a card statement with dates, statement amount, minimum due and optional reminder override.",
    "Record each payment with amount, date, method and reference; check remaining balance and reminders."],
    result="Upcoming card deadlines remain visible until paid.")
scenario("Raise, issue and collect a client certificate", "Finance > Client invoices", [
    "Select Raise a certificate and choose the project, type, title, dates, tax treatment, retention and deductions.",
    "Enter work lines, quantities and rates; review gross, VAT and net payable before saving draft.",
    "Use Issue when approved. For cash, card or bank transfer, use Record payment on that invoice."],
    result="The invoice's outstanding balance and ageing update; a direct receipt posts income once.",
    caution="For a cheque, use Cheques > Receive a client cheque and link the invoice, not Record payment.")
scenario("Receive and clear a client cheque", "Finance > Cheques > Received", [
    "Select Receive a client cheque; enter project, invoice if applicable, cheque number, drawer bank, payer, amount and dates.",
    "Record deposit-by date, reminder lead time, purpose and notes.",
    "Update status when deposited, then Cleared only when the bank confirms it; record a return if dishonoured."],
    result="Clearance posts the linked invoice receipt and income once; a cheque merely held is not cash received.")
scenario("Issue and clear a supplier cheque", "Finance > Cheques > Issued", [
    "Select Issue a future cheque; link supplier and invoice, then enter cheque number, bank/account, payee, amount, issue and cheque dates.",
    "Set reminder days, purpose and notes; review the follow-up queue.",
    "Confirm Cleared only after bank confirmation, or mark Returned/Cancelled/Replaced as appropriate."],
    result="A cleared linked cheque settles the supplier invoice once.",
    caution="Do not also record a direct Cheque payment on the supplier invoice.")
scenario("Record and extend a bank bond", "Finance > Bonds", [
    "Record bond type, beneficiary, bank, project if applicable, bond number, amount, margin, commission, issue/expiry dates and reminder days.",
    "Review approaching expiry in Bonds and Notifications.",
    "Use Extend for a later expiry, extension date, reminder setting and additional commission; update status when released, called or expired."],
    result="The bond history and risk reports retain live exposure and extensions.")
scenario("Operate three separate petty-cash accounts", "Finance > Petty cash", [
    "Open independent floats for Office expenses, Salary advance and Fuel, each with its own holder, ceiling and low-balance threshold.",
    "Top up each float separately. For Spend, choose the appropriate float, date, description and project/employee where relevant.",
    "Review movement history and balance after each entry."],
    result="Project-linked office/fuel spending can feed project costs; employee-linked salary advances feed payroll.",
    caution="Do not treat the three float balances as one pool or re-enter a petty-cash Spend under Expenses.")
scenario("Record an exceptional expense or non-invoice income", "Finance > Expenses / Income", [
    "Use these manual forms only when no linked source workflow already owns the transaction.",
    "For an expense, enter project, cost type, category, total amount, date, reference and description.",
    "For income, enter project, amount, received date, non-cheque method, reference and description."],
    result="The shared ledgers update project and company reporting; exact repeated manual entries are blocked.",
    caution="Use Bills, Supplier invoices, Client invoices, Cheques, Materials, Fleet, QS or Petty cash when one of those is the true source.")
scenario("Enter and settle a supplier invoice", "Finance > Supplier invoices", [
    "Choose supplier, related purchase order when available, invoice number, amount, invoice date and due date.",
    "Review the payable and only use direct Record payment for cash, card or bank transfer.",
    "For cheque settlement, create an Issued cheque linked to this invoice and confirm clearance later."],
    result="The payable decreases when payment is confirmed. Paid eligible supplier invoices appear in the VAT ledger.")
scenario("Check VAT and expense categories", "Finance > VAT ledger / Categories", [
    "Review output VAT from paid client invoices and input VAT from paid supplier invoices and operating bills.",
    "Check the net VAT figure against the detailed lines; this is a reporting aid, not a filing submission.",
    "Use Categories to add an expense category used for manual cost classification."],
    caution="Do not enter paid invoices again solely to make VAT appear; correct the source invoice and status.")

section(11, "Daily reports and analytics", "Site reports give a narrative of work done and explain delays. Project, Finance and system-wide reports turn source records into visual and tabular views.")
scenario("Submit the daily site report", "Daily reports > New daily site report", [
    "Choose project/site and report date; enter workforce on site, weather and delay hours.",
    "Describe work completed and any delays or issues; add material and equipment usage lines and site photos.",
    "Submit, then open the saved report to check its detail and evidence."],
    result="Project Daily intelligence, delay/weather reports and related dashboards update.",
    caution="The daily narrative is not a replacement for stock movement, attendance or payable records.")
scenario("Open a project's report library", "Project detail > Reports", [
    "Use search to find a report type and select it.",
    "Read the management narrative, measures, chart and supporting schedule.",
    "Export the table when you need a dated working copy."],
    result="Twenty project report types cover commercial, delivery, labour, material, equipment and document control.")
scenario("Open company or project financial reports", "Finance > Financial reports", [
    "Choose the operating company, all projects or one project, then optional from/to dates.",
    "Select one of the twenty report types from the left rail or search it by name.",
    "Read both charts and detailed records; use Export table for the current view."],
    result="The scope displayed at the top tells you which company's data is included.")
scenario("Generate a system-wide operational report", "Reports", [
    "Choose Projects, Budget, Profit, Daily progress, Attendance, Employees, Tasks, Materials, Purchases, Vehicles or Equipment.",
    "Set From and To dates and select Apply range.",
    "Review the generated table and use Export CSV if a spreadsheet copy is needed."],
    result="The exported CSV matches the report and date range on screen.")

section(12, "Communication, files and governance", "Use the built-in communication and file tools for project context and traceability, while keeping formal transactions in their own modules.")
scenario("Chat with a colleague or group", "Chat", [
    "Choose a person or create a group, then type and send a message.",
    "Use the conversation list to return to earlier discussions.",
    "For a formal task or site issue, also record it in Tasks or Project activity."],
    caution="A chat instruction alone does not create a task, expense, material issue or approved change.")
scenario("Store, share and retrieve files", "Drive; top-bar document search; record attachments", [
    "In Drive, navigate folders and upload a document to the correct place.",
    "Create a share link only for intended recipients and switch it off when access is no longer needed.",
    "For a file that proves a project, employee, invoice or equipment event, attach it to that record too."],
    result="Document search can find indexed files; the source record retains its own evidence.")
scenario("Review accountability", "Administration > Audit log / Fraud watch; top-bar bell", [
    "Inspect the audit trail when a value, status or assignment looks wrong.",
    "Compare any fraud-watch flag with source documents and the associated record.",
    "Work through deadline alerts daily and mark only resolved items read."],
    result="Decisions, corrections and exceptions remain reviewable by the MD.")

section(13, "Operating checklists and troubleshooting", "Use these compact routines to keep source records aligned and avoid double entry.")
list_block("At the start of a new project", [
    "Set the Operating company; convert a won inquiry or create the project once.",
    "Confirm manager, client, site, dates and opening budget; open the project detail page.",
    "Create milestones and tasks; assign people; record the initial BOQ and commercial terms.",
    "Open the gallery/documents and ensure a place exists for plans, approvals and site photographs.",
])
list_block("Each working day", [
    "Check Dashboard, Coordination, Workforce map, open tasks, project issues and deadline alerts.",
    "Record real attendance and correct site-direct arrivals; reconcile the biometric import queue.",
    "Receive/issue stock and record fleet movements at their source; submit site reports with evidence.",
    "Update QS actual cost and forecasts only for costs not already posted by source transactions.",
])
list_block("Each finance and payroll cycle", [
    "Review outstanding client and supplier invoices, cheque follow-ups, bill/card due dates and bonds.",
    "Confirm cash/cheque clearance before marking payments; inspect VAT source lines.",
    "Validate attendance, overtime, compensation and advances before payroll; inspect draft salary sheets before approval.",
    "Compare project and company reports and investigate exceptional variances or repeated-looking references.",
])
note("If a save fails", "Check required fields, the selected company/project, duplicate reference, date order, remaining balance and your current screen. Re-open the record before trying again: a successful prior save may already have been recorded.")
note("If figures differ", "Trace back to the source: invoice for receivables, bill or supplier invoice for payables, stock issue or QS entry for project cost, cheque status for cleared money, payroll draft for salary. Do not add a balancing manual entry just to make two screens agree.")
note("Data caveat", "Some older ledger rows may have similar amounts and references without a source link. Treat them as review candidates, not automatically proven duplicates. Reconcile them against receipts, invoices and bank evidence before any correction.")

section(14, "Report directory", "The following names match the current report selectors. Empty charts or tables mean the source workflow has no qualifying records for that project, company or date range.")
project_reports = ["Executive project summary", "Profit and loss", "Budget versus actual", "Project cash flow",
    "Cost category analysis", "Revenue and certification", "Client receivables and ageing", "Procurement commitments",
    "Supplier payables", "Programme progress", "Task productivity", "Labour and attendance", "Daily site operations",
    "Delay and disruption", "Weather impact", "BOQ item cost variance", "Unexpected and additional costs",
    "Material consumption", "Equipment deployment", "Project workforce allocation", "Document control"]
finance_reports = ["Executive financial summary", "Profit and loss statement", "Project profitability comparison",
    "Budget versus actual cost", "Cash flow movement", "Revenue and income analysis", "Expense analysis by category",
    "Accounts receivable and ageing", "Accounts payable and ageing", "Procurement commitments", "Payroll and labour cost",
    "Petty cash movement", "Retention exposure and releases", "VAT and invoice deductions", "Bank bonds and guarantees",
    "Cost forecast and overrun", "Unexpected and unallocated costs", "Variation financial impact",
    "Payment method analysis", "Monthly financial trend"]
report_grid("Project detail > Reports (21 types)", project_reports)
report_grid("Finance > Financial reports (20 types)", finance_reports)

story.append(PageBreak())
section(15, "Screen and feature map", "Use this as a final cross-check when looking for a feature. The listed tab labels are the current on-screen names. A module may also have detail pages and forms described in the scenarios above.")
module_map = [
    ("Dashboard", "Overview, status, alerts and quick links"),
    ("Coordination", "Live sites; Resource availability; Enquiries; Movement history"),
    ("Projects", "Projects; Milestones; BOQ & estimates; Variations; Inquiries. Project detail: Command centre; Activity & issues; Reports; Programme; Commercial; Subcontractors; Team; Gallery; Documents; Close-out"),
    ("Tasks", "Create, assign, follow up, approve, view history and attach files"),
    ("Quantity Surveying", "Cost control; Quotations; Bills of quantities; Tenders; Retention; Subcontractors"),
    ("People", "Employees; Workforce map; Attendance; Attendance register; Biometric import; Leave; Leave register; Overtime; Payroll; Payroll settings; Performance; Departments"),
    ("Materials", "Stock; Movements; Purchase requests; Orders; Suppliers"),
    ("Stock locations", "Locations; Tool handovers; BOQ usage"),
    ("Fleet", "Vehicles; Compliance; Fuel & service; Equipment"),
    ("Finance", "Financial reports; Budget monitoring; Bills; Credit cards; VAT ledger; Client invoices; Cheques; Bonds; Petty cash; Expenses; Income; Supplier invoices; Categories"),
    ("Daily reports", "Create and review dated site reports with materials, equipment and photos"),
    ("Chat / Drive", "Direct/group chat; folders; file uploads and share links"),
    ("Reports", "Projects; Budget; Profit; Daily progress; Attendance; Employees; Tasks; Materials; Purchases; Vehicles; Equipment"),
    ("Administration", "Users; Access control; Company; Documents; Designer; Notifications; Evening summary; Messages; Lists; Fraud watch; Audit log; My account"),
]
map_data = [[p("SECTION", "TableHeadGK"), p("WHAT IS INSIDE", "TableHeadGK")]]
map_data += [[p(name, "TableGK"), p(features, "TableGK")] for name, features in module_map]
map_table = Table(map_data, colWidths=[40*mm, 136*mm], repeatRows=1, hAlign="LEFT")
map_table.setStyle(TableStyle([
    ("BACKGROUND",(0,0),(-1,0),NAVY), ("ROWBACKGROUNDS",(0,1),(-1,-1),[WHITE,PALE]),
    ("GRID",(0,0),(-1,-1),0.35,BORDER), ("VALIGN",(0,0),(-1,-1),"TOP"),
    ("LEFTPADDING",(0,0),(-1,-1),7), ("RIGHTPADDING",(0,0),(-1,-1),7),
    ("TOPPADDING",(0,0),(-1,-1),6), ("BOTTOMPADDING",(0,0),(-1,-1),6),
]))
story.append(map_table)

story.append(Spacer(1, 6*mm))
story.append(p("End of guide", "H1GK"))
story.append(p("The next best step for a new MD is to practise one full project cycle in a test company: create a project, approve a BOQ, order and issue material, submit a daily report, invoice the client, record payment, run payroll and review the reports. Confirm each action appears once in its downstream views."))

GuideDoc(OUT).build(story)
print(OUT)
