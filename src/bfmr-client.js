const axios = require('axios');
require('dotenv').config();

class BfmrClient {
  constructor() {
    this.apiKey = process.env.BFMR_API_KEY;
    this.baseUrl = process.env.BFMR_API_URL || 'https://api.bfmr.com/api/v2';

    if (!this.apiKey) {
      throw new Error('BFMR_API_KEY is not set in .env');
    }

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 60000, // 60 second timeout to prevent infinite hangs
      headers: {
        'API-KEY': this.apiKey,
        'API-SECRET': process.env.BFMR_API_SECRET,
        'Content-Type': 'application/json',
        'User-Agent': 'BFMR-AutoBuyer/1.0'
      }
    });
  }

  async getDeals() {
    try {
      let allDeals = [];
      let currentPage = 1;
      let totalPages = 1;

      // Fetch all pages
      do {
        const response = await this.client.get('/deals', {
          params: {
            page: currentPage,
            limit: 50
          }
        });

        const data = response.data;
        allDeals = allDeals.concat(data.deals || []);

        // Update pagination info
        if (data.paging) {
          totalPages = data.paging.last_page || data.paging.pages || 1;
          console.log(`Fetched page ${currentPage}/${totalPages} (${data.deals.length} deals)`);
        }

        currentPage++;
      } while (currentPage <= totalPages);

      console.log(`✅ Total deals fetched: ${allDeals.length}`);

      return {
        message: 'success',
        deals: allDeals,
        paging: {
          total: allDeals.length,
          pages: totalPages
        }
      };
    } catch (error) {
      console.error('Error fetching deals from BFMR:', error.message);
      if (error.response) {
        console.error('Response data:', error.response.data);
      }
      throw error;
    }
  }

  async getDealBySlug(slug) {
    try {
      const response = await this.client.get(`/deals/${slug}`);
      return response.data.deal;
    } catch (error) {
      if (error.response && error.response.status === 404) {
        console.log(`Deal not found via API: ${slug}`);
        return null;
      }
      console.error(`Error fetching deal by slug ${slug}:`, error.message);
      return null;
    }
  }

  async submitTracking(dealId, trackingNumber, quantity, cost, orderId = null) {
    try {
      const payload = {
        tracking_number: trackingNumber,
        quantity: quantity,
        cost: cost
      };

      if (orderId) {
        payload.order_no = orderId;
      }

      const response = await this.client.post(`/deals/${dealId}/tracking`, payload);
      return response.data;
    } catch (error) {
      console.error(`Error submitting tracking for deal ${dealId}:`, error.message);
      throw error;
    }
  }
}

module.exports = BfmrClient;
