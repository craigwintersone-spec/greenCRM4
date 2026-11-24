# Vorlana changelog
Newest first. The Sentinel reads this every morning and logs what shipped in the last 7 days.

## 2026-11-24
- Funder reports read cleaner: one people figure to date (the target progress), never a second count that disagrees; the writer no longer repeats its own instructions in the report ("figures relate only to…", "harvested food is not waste diverted"); each figure and pace verdict is given once; data quality gives the feedback response rate (136 responses from 272 attendances, 50%) instead of explaining what measures are not; the circular figures appear once (the contract report keeps the written section and the detail tables, not a second set of boxes)
- Funder reports: progress against targets is worked out in code (starts and outcomes to date against the share of the contract period gone: ahead of pace, on track or behind) and the writer must use that verdict; employment and sustained outcomes only appear on employment contracts or when there are any; events with nothing recorded are left out, as in the delivery report; repeated quotes are removed; the verification box, "Org Brain" and "Vorlana starter estimates" no longer appear in the download (estimates are called standard averages); data notes stay in the data quality section and the Forward Plan only appears when the organisation has written its plans; the browser's web address and date no longer print on the contract report; circular item counts now add up (items with an outcome = the outcomes listed), compost out of 0 kg and bed-by-bed yields are left out; sentences that restate a percentage in words ("This is a majority of responses") are removed; a heading written straight above its text always shows as a heading
- The score only goes up: Raise the score now keeps a round of rewrites only if the bid scores higher, otherwise every answer is put back. The score uses a fixed five-part rubric (fit, evidence, community, money, clarity — 20 each) and the same answers are never re-scored, so checking again doesn't move it. No rewrite is kept if it goes over the limit, stops mid-sentence, changes a £ figure or changes the people target. The score panel lists problems the code finds itself (over the limit, cut off, a people number that doesn't match the target) with one-tap fixes, and changing the target updates it in every answer
- Value for money: the money panel now holds how many people the bid will reach and shows the cost per person, compared with what the organisation's work costs now (spending ÷ people supported a year, a new field in Details for bids). If it's high: 'Raise the target' works out a realistic number from how the work runs, or 'It's right — explain why' adds the reasoning to the bid. The target is locked like the money and 'Put these figures in every answer' updates it everywhere
- The money: every bid has one money sheet (amount asked, total cost, other funding and whether it's secured, budget lines) that Vorlana adds up in code. It flags lines that don't add up, an ask over the funder's maximum, and any answer that states a different total or ask, with one-tap fixes; 'Put these figures in every answer' writes the budget answer from the lines and corrects the money in the rest. Rewrites can no longer change or invent £ figures
- Every gap under To finish now comes with a suggested answer — from your records where they have it, otherwise what's typical for your size and in line with the funder's rules (marked 'check it') — with one tap to use it, or 'Use all suggestions'. Answers that can't be right (reserves more than twice your income, a percentage over 100, words where a number is needed) are flagged in amber and held back unless you press again
- Raise the score: one button on a bid has the assessor list what costs marks, rewrites the weak answers to fix it from your own records, and scores again (up to two rounds, with Undo). Anything only you can supply comes back as a question under To finish. Values typed into gaps are now worked into the sentence properly, and ones that don't make sense (like reserves bigger than your income) are asked again
- Find funding redesigned: tabs for Opportunities, Bids in progress, Saved and Won & lost; one line says who you're searching for (details open in a side panel); one progress bar; funder cards show the amount and deadline big (amber when it closes soon) with Write the bid, Save and Not for us; your last search stays on the page. Writing a bid opens full screen with five steps (Funder, Questions, Answers, Gaps, Download), what the funder wants at the top, answers you edit in place with a word-count bar, Make shorter and Make stronger (with Undo), a bid strength score out of 100, and one To finish checklist for gaps, confirmations and documents
- New organisations are looked up on the public register (Find that Charity) when they sign up: charity/company number, address, turnover this year and last, spending, staff, volunteers and trustees go straight into every bid. Existing organisations get a one-tap "Find us" on Find funding. All of it can be checked and corrected in Settings › Organisation › Details for bids; the money check now only asks for what's missing
- Find funding shows who each funder has actually given to (360Giving open data): groups like you nearby, typical grant size, last award and examples; funders who back similar local groups rank higher. A fourth search looks for funders by what they've already funded
- Bids never invent money: a one-off "three numbers" check (last year's spending, money secured, reserves) feeds the amount, budget and finance sections; the assessor checks the request against the funder's rules and their typical grant
- Only real declarations go to "Only you can confirm"; facts become remembered gaps, narratives are written, and "If you selected Yes…" follow-ups are answered from the question before
- Proposals list every section from the funder's guidelines, each with its own job; attendances are never presented as people
- Answer library: bids reuse your strongest past answers, won bids first. Documents checklist: what each funder wants attached, ticked off and saved with the bid
- Every bid is written for its funder: Vorlana reads how they decide, what they want submitted, their money rules and style; project ideas follow their rules (share of cost, match funding, total cost and where the rest comes from); the assessor check rewrites anything generic
- Funders that judge a written proposal (such as Garfield Weston) now get one, section by section within their page limit, alongside the form answers
- Declarations, policies, tax status and "applied before?" are never answered for you: they're listed under "Only you can confirm these"
- A warning when the funder's guidance excludes your type of organisation (for example CICs)
- Past bids open again: every bid's questions and answers are saved, kept up to date as you edit or fill gaps, and can be reopened from Your bids to edit, download or reuse (run the new lines in bid-tracker.sql)

## 2026-11-23
- Bids: character limits are kept as characters (shown as 612/750 characters) and answers are cut to fit; when the funder's actual form can't be opened, the bid says the questions and limits came from their guidance so they can be checked; answers can no longer stop mid-sentence (the AI gets more room and retries if it runs out)
- Bids leave far fewer gaps: the same gap asked in different words becomes one question, project ideas only use the organisation's existing venues and activities, and the writer and assessor drop unsupported claims or reason them out instead of leaving "confirm…" or "explain…" gaps
- Bids: the plan now sets the right length for every question (one-line facts stay one line), keeps one fact sheet so numbers agree everywhere, hands out each quote once, times seasonal projects realistically and suggests a budget that adds up; an assessor-style check of the whole bid then rewrites any answer that misses its question, contradicts itself, repeats or overclaims
- Fill the gaps: every [INSERT] in one short list, answered once and dropped into every answer; organisation facts are remembered for the next bid (bank details never are)
- Find funding searches with Claude Opus 5.5, then checks every result on the funder's own page: does the link open, is it still open, the real deadline and grant size, and whether this organisation can apply. Closed or ineligible results are removed (and listed), checked ones are marked
- Bids now use richer evidence: feedback headlines, real quotes, who the organisation reaches (black and ethnic minority, disabled, age), the six-month trend and a real anonymised story
- Bid tracker with no admin: bids are saved when written and marked sent when downloaded or copied; "Your bids" shows the win rate and money raised; 8 weeks after sending, one email asks "Did you win?" with one-tap answers (needs bid-tracker.sql)
- AI models upgraded: bids are written by Claude Fable 5.2, funding searches and form reading by Sonnet 5.5, everyday jobs by Haiku 5.5. If a model isn't available, Vorlana steps down to the next one automatically
- Bids: Vorlana now reads the funder's own guidance (priorities, what assessors look for, eligibility, grant size), suggests three projects built from what the organisation already does (one tap to choose), plans the whole bid so answers build one argument without repeating, writes the answers side by side, and trims any answer that runs over the word limit
- Find funding is much faster: the three searches now run side by side, results appear as each one finishes, and merging happens instantly in the browser (one fewer AI call per search)
- AI calls can run up to three at a time instead of one after another
- New look: cleaner type, soft cards, pill buttons, line icons instead of emoji
- Shorter sidebar: ten sections that open and close (People, Events, Impact, Funders, Contacts, Growth), with plainer names (Home, Funder health, Find funding, From partners)
- Dashboard: "Last 30 days" with the change on the month before and six-month trend lines for sessions, attendance, volunteer hours and confidence
- Funder health: contracts with no targets show "No targets set" instead of red; a contract with only one target is judged on that target
- Demo mode now shows a realistic community charity (garden, repair café, wellbeing walks, family cooking, warm space) with six months of sessions, feedback, volunteers and funders; no employment sample data and no "(DEMO)" labels
- Demo accounts: an organisation with settings.demo_account = true always opens with the sample data, without affecting the person's other organisations
- Homepage: first customer testimonial; ICO registration number ZC228828 on the privacy policy and footer

## 2026-11-20
- New prices: Starter £29 a month (new, for volunteer-run groups: 1 funder contract, 2 staff logins), Community £79, Standard £149, Provider £349; annual plans two months free
- Booking emails: replies go to the organisation's own address

## 2026-11-03
- Volunteers can say how long they're volunteering when they check in, and are checked out automatically at that time; leaving early still records their real time. Organisations can add their own note at volunteer check-in (Settings > Events)

## 2026-10-31
- Volunteer sign-ups from QR codes now email the organisation straight away, and send the volunteer a thank-you from "<Organisation> via Vorlana" with replies going to the organisation (Settings > Events)

## 2026-10-25
- Event bookings: every upcoming event can be booked from the organisation's What's on page (free, paid, concessions), with a waiting list when full and booking closing at the start time
- Payments go straight to the organisation's own Stripe account; no booking fee
- Confirmation, waiting-list, cancellation and day-before reminder emails; cancel in one tap
- On the day, the phone that booked is recognised (or people enter their email), counted once as an anonymous check-in, then asked the funder's questions
- Staff: price on the event, a Booked column, who's coming, mark arrivals, phone and cash bookings, no-shows
- Sentinel's daily checks now actually run (the daily job calls them)

## 2026-10-21
- New prices: Community £149 a month (£1,490 a year), Standard £290 (£2,900), Provider £590 (£5,900), Partnership from £8,000 a year; on the website, super admin and the Sales agent
- Plan limits are real: Community and trial up to 2 live funder contracts; staff logins 3 (Community, trial), 10 (Standard), unlimited (Provider), checked when an invite is sent
- Free trials can use the AI for 14 days, 30 calls a day, so they see reports write themselves
- Unlimited volunteers and participants on every plan

## 2026-10-19
- Check-in: a phone that has already checked in today offers "Next person on this phone" or "Give feedback", in the order that fits the time
- Check-in: the next person on the same phone starts with children at N/A, with a note, so children are not counted twice
- "Keep me updated" tick box on check-in and feedback: name and email go to Contacts as Mailing list, never into the answers, never twice
- Feedback no longer asks where you attended, or for a name or email inside the answers
- Feedback page: choose an event to see every question with its results

## 2026-10-18
- Session report shows only the questions a feedback form asked, with their results; "not asked" is never reported as nil
- Feedback questions are matched to report figures automatically from their wording, shown as "counts as…", and a name or email box can never count
- Events page shows a Feedback count per event that opens the responses
- Feedback page lists newest first
- Sentinel checks the whole platform every morning: people and safeguarding, referrals, evidence, intake, contracts and forms, events, feedback, check-ins, volunteers, circular, contacts, team access, plans, privacy (tables readable without login), and whether the site and its services answer

## 2026-10-17
- Session report includes check-ins: a Checked in tile, a Who came section and a table per question
- Events page has a Checked in column with a per-event answer summary and CSV
- Contacts: Edit works for every contact; phone and notes on the contact screen

## 2026-10-15
- Check in tab on every event QR, with funder-specific check-in forms, an editor, and a choice per event
- Interested in volunteering: leads land on the Contacts tab
- Word and pasted forms read correctly
- An event always saves, even if its check-in choice cannot

## 2026-10-14
- Contracts: reporting requirements and the funder's start, outcome and reporting forms in the Add/Edit contract screen
- Zero-touch funder reports: one email when a period ends; the link writes the report and fills the funder's Word return

## 2026-10-13
- Growing: harvest log, split between places, Harvested list, place a harvest later
- Compost activity: compost in and out
- One QR for event or site volunteering
- Feedback forms dropped in per event; reports clean their own wording
