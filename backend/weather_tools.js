const axios = require('axios');

const WMO_CODES = {
    0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Foggy', 48: 'Icy fog', 51: 'Light drizzle', 53: 'Moderate drizzle',
    55: 'Dense drizzle', 61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
    71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow', 77: 'Snow grains',
    80: 'Slight showers', 81: 'Moderate showers', 82: 'Violent showers',
    85: 'Slight snow showers', 86: 'Heavy snow showers',
    95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Thunderstorm with heavy hail',
};

/**
 * Geocode a city name to lat/lon using Open-Meteo geocoding API (no API key required).
 */
async function geocode(location) {
    const res = await axios.get('https://geocoding-api.open-meteo.com/v1/search', {
        params: { name: location, count: 1, language: 'en', format: 'json' }
    });
    if (!res.data.results || res.data.results.length === 0) {
        throw new Error(`Could not geocode location: ${location}`);
    }
    const { latitude, longitude, name, country } = res.data.results[0];
    return { latitude, longitude, name, country };
}

/**
 * Get current weather and 3-day forecast for a given location.
 * Uses Open-Meteo — completely free, no API key required.
 * @param {string} location - e.g. 'Bengaluru', 'London', 'New York'
 */
async function getWeather(location) {
    try {
        const { latitude, longitude, name, country } = await geocode(location);

        const res = await axios.get('https://api.open-meteo.com/v1/forecast', {
            params: {
                latitude,
                longitude,
                current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m',
                daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum',
                timezone: 'auto',
                forecast_days: 4,
            }
        });

        const c = res.data.current;
        const d = res.data.daily;

        const current = {
            location: `${name}, ${country}`,
            temperature: `${c.temperature_2m}°C`,
            feelsLike: `${c.apparent_temperature}°C`,
            humidity: `${c.relative_humidity_2m}%`,
            wind: `${c.wind_speed_10m} km/h`,
            condition: WMO_CODES[c.weather_code] || 'Unknown',
        };

        const forecast = d.time.map((date, i) => ({
            date,
            condition: WMO_CODES[d.weather_code[i]] || 'Unknown',
            high: `${d.temperature_2m_max[i]}°C`,
            low: `${d.temperature_2m_min[i]}°C`,
            rain: `${d.precipitation_sum[i]}mm`,
        }));

        return JSON.stringify({ current, forecast });
    } catch (err) {
        throw new Error(`Weather fetch failed: ${err.message}`);
    }
}

module.exports = { getWeather };
