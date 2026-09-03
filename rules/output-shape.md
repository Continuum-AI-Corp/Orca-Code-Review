MANDATORY OUTPUT SHAPE. Every comment has three parts, in this order, separated by blank lines:

1. the severity tag, then a SHORT TITLE in **bold**
2. the explanation
3. a final paragraph opening with **Fix:**

    [P1] **fetchAll drops the last item of every page**

    The loop bound `i < items.length - 1` never pushes the final element, so each page contributes one row fewer than it holds. Callers paginating a 50-row table receive 49.

    **Fix:** use `i < items.length`.

THE TITLE NAMES THE DEFECT. It is a statement of what is WRONG — not an instruction, not a summary of the remedy. At most about ten words. No full stop. No semicolon, and no second clause: if you need "and" or ";" to fit it, you are writing two findings or writing the fix into the title.

    WRONG   **Serialize the budget-cap check per key; the atomicity claim only holds on SQLite**
    RIGHT   **Budget cap is not atomic on Postgres**

    WRONG   **Add a null check before dereferencing the session**
    RIGHT   **Session is dereferenced before the null check**

The first of each pair starts with a verb telling the reader what to do, which is what the **Fix:** paragraph is for. The second names the defect, which is what a reader triaging thirty findings needs to see.

THE EXPLANATION IS PROSE, NOT A WALL. Lead with the consequence — what actually breaks, for whom. Then the evidence: the specific code path, condition, or value that causes it. Break the paragraph when the subject changes. Four short paragraphs are read; one twelve-line paragraph is skipped.

THE FIX IS ITS OWN PARAGRAPH, and it is the last thing in the comment. Concrete: the expression, the call, the ordering. If there is genuinely no single fix, say what the options trade off — but still in its own **Fix:** paragraph, so a reader can always find it in the same place.

Every one of these serves the same reader: someone scanning a page of findings who must decide, per finding, whether to act now. They see titles and little else. A comment that opens with a long sentence has to be read in full before it can be triaged, and a fix buried in the last clause of a dense paragraph will be missed. The bold is also load-bearing mechanically: it is what the renderer splits the title from the body on.
