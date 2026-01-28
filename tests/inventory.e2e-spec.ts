import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { setupTestDatabase } from './utils/test-database';

describe('InventoryController (e2e)', () => {
  let app: INestApplication;
  let authToken: string;

  beforeAll(async () => {
    await setupTestDatabase();
    
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    // Get auth token
    const loginResponse = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'admin@example.com',
        password: 'password123',
      });
    
    authToken = loginResponse.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('/inventory/stock/:productId (GET)', () => {
    it('should return stock level with API key', () => {
      return request(app.getHttpServer())
        .get('/inventory/stock/prod123')
        .set('X-API-Key', 'test-api-key')
        .expect(200)
        .expect((res) => {
          expect(res.body).toHaveProperty('availableStock');
          expect(res.body).toHaveProperty('productId', 'prod123');
        });
    });

    it('should return 401 without API key', () => {
      return request(app.getHttpServer())
        .get('/inventory/stock/prod123')
        .expect(401);
    });
  });

  describe('/inventory/stock (POST)', () => {
    it('should update stock with valid token', () => {
      return request(app.getHttpServer())
        .post('/inventory/stock')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          productId: 'prod123',
          warehouseId: 'warehouse1',
          quantity: 10,
          operation: 'ADD',
          reason: 'Restock',
        })
        .expect(200)
        .expect((res) => {
          expect(res.body).toHaveProperty('quantity');
          expect(res.body).toHaveProperty('available');
        });
    });

    it('should return 403 without proper role', async () => {
      const userToken = await getTokenForUser('user@example.com');
      
      return request(app.getHttpServer())
        .post('/inventory/stock')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          productId: 'prod123',
          warehouseId: 'warehouse1',
          quantity: 10,
          operation: 'ADD',
          reason: 'Restock',
        })
        .expect(403);
    });
  });
});
