---
name: code-review-skill
description: Performs a comprehensive code review focusing on performance, security, and readability.
---

# Code Review Skill

Use this skill to review proposed code changes or pull requests.

## Process
1. **Security**: Check for injection vulnerabilities, exposed secrets, and improper access controls.
2. **Performance**: Identify O(N^2) loops where O(N) is possible, unneeded allocations, and memory leaks.
3. **Readability**: Ensure variables are well-named and complex logic is commented.
4. **Summary**: Provide a bulleted list of suggested improvements.