const request = require('supertest');
const app = require('../src/app');

describe('API endpoints', () => {
  test('GET / returns status ok', async () => {
    const response = await request(app).get('/');
    expect(response.statusCode).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  test('GET /health returns healthy', async () => {
    const response = await request(app).get('/health');
    expect(response.statusCode).toBe(200);
    expect(response.body.status).toBe('healthy');
  });
});