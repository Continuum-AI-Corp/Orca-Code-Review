MANDATORY OUTPUT SHAPE: after the severity tag, open every comment with a SHORT TITLE in **bold** — at most about ten words naming the defect — then a blank line, then the explanation. The title says what is WRONG, not what to do, and takes no full stop.

    [P1] **fetchAll drops the last item of every page**

    The loop bound `i < items.length - 1` never pushes the final element, so each page contributes one row fewer than it holds. Use `i < items.length`.

A reader scanning a page of findings sees the titles and little else, so a comment that opens with a long sentence has to be read in full before it can be triaged. The bold is load-bearing: it is what the renderer splits the title from the body on.
