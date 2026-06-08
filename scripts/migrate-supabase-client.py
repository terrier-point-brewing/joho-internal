#!/usr/bin/env python3
"""
Replaces the module-level singleton supabase import with per-request
createSupabaseServerClient() calls in all API route handlers.

Handles multi-line function signatures by tracking parenthesis depth to
find the actual function body opener, not a { inside a parameter.
"""
import sys

OLD_IMPORT = 'import { supabase } from "@/lib/supabase/client";'
NEW_IMPORT = 'import { createSupabaseServerClient } from "@/lib/supabase/server";'
INIT_LINE  = '  const supabase = await createSupabaseServerClient();\n'
VERBS      = {'GET', 'POST', 'PUT', 'PATCH', 'DELETE'}

def find_body_brace(src: str, start: int) -> int:
    """
    Given an index pointing to the '(' of an export async function declaration,
    walk forward tracking paren depth until we find the closing ')', then find
    the opening '{' of the function body.
    Returns the index of that '{', or -1 if not found.
    """
    i = start
    depth = 0
    in_str = None
    n = len(src)
    # First: skip past the parameter list (depth goes 1→0)
    while i < n:
        c = src[i]
        if in_str:
            if c == '\\':
                i += 2
                continue
            if c == in_str:
                in_str = None
        else:
            if c in ('"', "'", '`'):
                in_str = c
            elif c == '(':
                depth += 1
            elif c == ')':
                depth -= 1
                if depth == 0:
                    i += 1
                    break
        i += 1
    # Now scan past whitespace/newlines/return-type annotation to find '{'
    while i < n:
        c = src[i]
        if c == '{':
            return i
        # Allow whitespace, colon (return type), alphanumeric/symbols in type annotation
        # Stop only at ';' or another statement start that's wrong
        if c == ';':
            return -1
        i += 1
    return -1


def transform(src: str) -> str:
    if OLD_IMPORT not in src:
        return src

    src = src.replace(OLD_IMPORT, NEW_IMPORT)

    result = []
    i = 0
    n = len(src)

    while i < n:
        # Look for 'export async function '
        marker = 'export async function '
        idx = src.find(marker, i)
        if idx == -1:
            result.append(src[i:])
            break

        # Append everything up to and including the marker
        result.append(src[i:idx + len(marker)])
        i = idx + len(marker)

        # Read the function name
        j = i
        while j < n and (src[j].isalnum() or src[j] == '_'):
            j += 1
        name = src[i:j]

        if name not in VERBS:
            # Not a handler verb — skip
            result.append(src[i:j])
            i = j
            continue

        result.append(src[i:j])
        i = j

        # Find the '(' to start paren tracking
        paren_start = src.find('(', i)
        if paren_start == -1:
            result.append(src[i:])
            break

        # Find the body '{'
        body_brace = find_body_brace(src, paren_start)
        if body_brace == -1:
            # Couldn't find body — leave unchanged
            result.append(src[i:])
            break

        # Append from current position up to and including '{'
        result.append(src[i:body_brace + 1])
        i = body_brace + 1

        # Insert the init line
        result.append('\n' + INIT_LINE)

    return ''.join(result)


if __name__ == "__main__":
    for path in sys.argv[1:]:
        with open(path) as f:
            original = f.read()
        updated = transform(original)
        if updated != original:
            with open(path, 'w') as f:
                f.write(updated)
            print(f"  updated: {path}")
        else:
            print(f"  skipped: {path}")
