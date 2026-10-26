const fs = require('fs');
let c = fs.readFileSync('llm_router.js', 'utf8');

const browserMatchCode = `
    // "play X in brave" / "search X on chrome"
    const browserSearchMatch = lowerPrompt.match(/(?:search|find|play|open)\\s+(.+?)\\s+(?:on|in|via|using|from)\\s+(brave|chrome|edge|browser)/i);
    if (browserSearchMatch) {
        const query = browserSearchMatch[1].trim();
        const browser = browserSearchMatch[2].trim().toLowerCase();
        console.log(\`[Router] Direct Web Search on \${browser} -> "\${query}"\`);
        let exe = 'start';
        if (browser === 'brave') exe = 'start brave';
        else if (browser === 'chrome') exe = 'start chrome';
        else if (browser === 'edge') exe = 'start msedge';
        
        if (/(?:play|watch)/i.test(lowerPrompt)) {
             require('child_process').exec(\`\${exe} "https://www.youtube.com/results?search_query=\${encodeURIComponent(query)}"\`);
             return \`Searching YouTube for \${query} on \${browser}, sir.\`;
        } else {
             require('child_process').exec(\`\${exe} "https://www.google.com/search?q=\${encodeURIComponent(query)}"\`);
             return \`Searching the web for \${query} on \${browser}, sir.\`;
        }
    }
`;

const insertPos = c.indexOf('    const spotifyMatch =');
if (insertPos !== -1 && !c.includes('browserSearchMatch')) {
    c = c.slice(0, insertPos) + browserMatchCode + '\r\n' + c.slice(insertPos);
    fs.writeFileSync('llm_router.js', c);
    console.log('Added browserMatchCode successfully');
} else {
    console.log('Could not find insertion point or already added');
}
