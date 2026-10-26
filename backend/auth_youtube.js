const { google } = require('googleapis');
const fs = require('fs');
const readline = require('readline');
const path = require('path');

const credentialsPath = path.join(__dirname, 'client_secret.json');
const tokenPath = path.join(__dirname, 'token.json');

const content = fs.readFileSync(credentialsPath, 'utf8');
const credentials = JSON.parse(content);
const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
const oAuth2Client = new google.auth.OAuth2(
    client_id, 
    client_secret, 
    (redirect_uris && redirect_uris[0]) || 'urn:ietf:wg:oauth:2.0:oob'
);

const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/youtube.upload'],
});

console.log('\n======================================');
console.log('Click this link to authorize YouTube:');
console.log(authUrl);
console.log('======================================\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Enter the code from the page here: ', (code) => {
    rl.close();
    oAuth2Client.getToken(code, (err, token) => {
        if (err) return console.error('Error retrieving token:', err.message);
        fs.writeFileSync(tokenPath, JSON.stringify(token));
        console.log('\nSUCCESS! token.json has been updated with a permanent token.');
    });
});
