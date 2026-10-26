let nodemailer;
try { nodemailer = require('nodemailer'); } catch(_) {}

let transporter = null;

function getTransporter() {
    if (transporter) return transporter;

    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
        throw new Error('Email not configured. Add SMTP_USER and SMTP_PASS to your .env file. For Gmail, generate an App Password at myaccount.google.com/apppasswords');
    }

    if (!nodemailer) {
        throw new Error('nodemailer is not installed. Run: npm install nodemailer in the backend directory.');
    }

    transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
        },
    });

    return transporter;
}

/**
 * Send an email via SMTP (Gmail by default).
 * @param {string} to - Recipient email address
 * @param {string} subject - Email subject
 * @param {string} body - Email body (plain text or HTML)
 * @param {string|null} attachmentPath - Optional absolute path to file attachment
 */
async function sendEmail(to, subject, body, attachmentPath = null) {
    try {
        const transport = getTransporter();

        const mailOptions = {
            from: process.env.SMTP_USER,
            to,
            subject,
            text: body,
        };

        if (attachmentPath) {
            const path = require('path');
            const fs = require('fs');
            if (fs.existsSync(attachmentPath)) {
                mailOptions.attachments = [{
                    filename: path.basename(attachmentPath),
                    path: attachmentPath,
                }];
            }
        }

        const info = await transport.sendMail(mailOptions);
        return `Email sent successfully. Message ID: ${info.messageId}`;
    } catch (err) {
        throw new Error(`Email dispatch failed: ${err.message}`);
    }
}

module.exports = { sendEmail };
