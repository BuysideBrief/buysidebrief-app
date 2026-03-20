require('dotenv').config();

const url = 'https://www.sec.gov/Archives/edgar/data/1897926/000189792626000002/ownership.xml';
const UA = process.env.SEC_USER_AGENT || 'BuysideBrief hello@buysidebrief.com';

fetch(url, { headers: { 'User-Agent': UA } })
  .then(async res => {
    console.log('Status:', res.status);
    console.log('Content-Type:', res.headers.get('content-type'));
    const text = await res.text();
    console.log('Length:', text.length);
    console.log('First 500 chars:', text.substring(0, 500));
  })
  .catch(e => console.error('Fetch error:', e.message));
