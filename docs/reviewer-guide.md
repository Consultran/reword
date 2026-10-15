# Reviewing a website with Reword

Reword lets you mark up one of our websites right in Chrome. Change wording, delete things, drag sections around and leave notes. When you're done, Reword gives you one block of text. Email it to Ben, and he hands it to the AI that updates the site.

Nothing you do changes the real website. Your edits only show up in your own browser until Ben applies them.

## Install it (once)

1. Save the `reword-chrome.zip` file Ben sent you, then double-click it. You'll get a folder called `reword-chrome`.
2. Move that folder somewhere it won't get deleted, like your Documents folder. Chrome loads it from there every time.
3. In Chrome, go to `chrome://extensions`.
4. Turn on **Developer mode** (the switch in the top right corner).
5. Click **Load unpacked** and pick the folder from step 2.
6. Click the puzzle-piece icon in Chrome's toolbar and pin **Reword** so its button stays visible.

Chrome may show a banner about developer-mode extensions. That's normal for tools we build ourselves. Close it.

## Mark up a page

1. Open the link Ben sent you. It's either the live site or a preview link ending in `workers.dev`.
2. Click the **Reword** button in the toolbar, or press **Option+Shift+E**. A changes panel appears in the bottom right corner.
3. Point at anything on the page. An outline shows what you're about to pick. Click to select it, and a small toolbar appears next to it:
   - **Edit text**: type the new wording right on the page. **Enter** saves. **Esc** cancels.
   - **Remove**: hides it. You're telling Ben "delete this."
   - **Note**: type an instruction, like "make this button bigger" or "swap this photo for the truck photo I sent." Save with **Cmd+Enter**.
   - **Drag handle (⠿)**: drag the item to a new spot on the page.
   - **↑ parent**: grabs the bigger box around what you clicked, handy when you clicked a single word inside a button.
4. To click a link or open a menu without selecting it, **hold Option** while you click. Let go of Option to go back to marking up.
5. You can move between pages on the same site. Every change you make across the whole site goes into one list.

Made a mistake? Click **×** next to the change in the panel, or press **Cmd+Z**.

## Send it to Ben

1. In the changes panel, click **Copy prompt**.
2. Paste it into an email or Slack message to Ben. Say which site it's for.
3. If you're swapping images, attach the image files to the same message. Name them the way your notes do, like `hero-truck.jpg`.
4. Once it's sent, click **Clear all** in the panel. Otherwise those changes go into your next prompt too.

Your changes are saved if you close Chrome or restart your computer, so you can work across several days. Keep one review per link. Changes on the live site and changes on a preview link are kept in separate lists.

## Tips

- Send one prompt per page or per sitting. Smaller batches are easier for Ben to check.
- Notes can say anything. "This section feels cramped" or "add a testimonials strip below this" both work.
- If a page looks wrong after you reload it, open Reword again. Your changes come back.
