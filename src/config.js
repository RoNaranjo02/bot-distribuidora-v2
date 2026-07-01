require('dotenv').config();

module.exports = {
  allowedNumbers: process.env.ALLOWED_NUMBERS.split(','),
  groupId: process.env.GROUP_ID,
  sheetId: process.env.GOOGLE_SHEET_ID,
  googleCredentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON),
  mongoUri: process.env.MONGODB_URI,
};