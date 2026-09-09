/**
 * *Save a diagnostic report…* — story 25, criteria 25a and 25i, as a menu item.
 *
 * ⚠️ **It moved out of the window on the founder's ruling of 2026-09-09**, after seeing it
 * on screen: *"from a UI perspective, this needs to be tucked into a menu, this doesn't need
 * to be visible at all."* They are right, and it is a better answer than the spec's. A
 * diagnostic is used once a year by somebody who has hit a problem; it was occupying the
 * main column every other day of its life, and every pixel it took is a pixel 22b has to
 * account for at the minimum window.
 *
 * ## What that changes about 25a, and why the menu is stronger
 *
 * 25a asks for a control **present and pressable in every state**. A panel had to be built
 * unconditionally and kept out of every inert-while-asking path to manage that — three
 * places where a future change could quietly remove it. **A menu item is outside the view
 * model entirely**, so there is no state in which it can fail to render, and nothing to
 * remember.
 *
 * ## What that changes about 25i, and why there is a dialog
 *
 * 25i asks the app to say what is removed **before the control is pressed**. A menu item
 * carries no sentence, so the sentence became this confirmation. **That is not a modal for
 * its own sake**: without it the first time anybody learns what the file contains is after
 * it exists, which is exactly the "app decided something private on your behalf" that
 * question 45 was asked to avoid.
 */

export const DIAGNOSTIC_MENU_LABEL = 'Save a diagnostic report…';

/**
 * ⚠️ **25i is amended, and this is where the reasoning lives.**
 *
 * The criterion asked the app to say what is removed *"before the control is pressed"*. The
 * first attempt was a confirmation dialog — and `quit-prompt.test.ts` failed it by name:
 * *"the founder's ruling of 2026-08-30: make it in-window, no modals. This is the one that
 * fails if somebody reaches for a message box again, **including for a new question that has
 * nothing to do with quitting**."* The rule anticipated exactly this.
 *
 * So the sentence moved into the **first nine lines of the report itself**, which the person
 * reads in the window Explorer opens, before they send anything.
 *
 * **That is the moment the criterion was actually protecting.** Writing a file on your own
 * machine is not sharing; sending it is. The header states what was replaced and that
 * CastGood sent nothing, and it is read at the only point where either fact can change what
 * somebody does.
 *
 * The criterion should be reworded to *"before it leaves the machine"* rather than quietly
 * treated as met.
 */
export const REPORT_HEADER_CARRIES_25I = true;
