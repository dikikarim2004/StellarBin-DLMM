import { Router } from "express";
import { ListTokensResponse } from "@workspace/api-zod";

const router = Router();

export const TOKENS = [
  {
    symbol: "XLM",
    name: "Stellar Lumens",
    address: "native",
    decimals: 7,
    price: 0.1142,
    priceChange24h: 2.34,
    logoUrl: "https://assets.coingecko.com/coins/images/100/small/Stellar_symbol_black_RGB.png",
  },
  {
    symbol: "USDC",
    name: "USD Coin",
    address: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    decimals: 7,
    price: 1.0001,
    priceChange24h: 0.01,
    logoUrl: "https://assets.coingecko.com/coins/images/6319/small/USD_Coin_icon.png",
  },
  {
    symbol: "yXLM",
    name: "Yield XLM",
    address: "GARDNV3Q7YGT4AKSDF25LT32YSCCW4EV22Y2TV3I2PU2MMXJTEDL5T55",
    decimals: 7,
    price: 0.1198,
    priceChange24h: 1.87,
    logoUrl: "https://assets.coingecko.com/coins/images/100/small/Stellar_symbol_black_RGB.png",
  },
  {
    symbol: "BTC",
    name: "Bitcoin (Stellar)",
    address: "GDPJALI4AZKUU2W426U5WKMAT6CN3AJRPIIRYR2YM54TL2GDWO5O2MZM",
    decimals: 7,
    price: 67420.5,
    priceChange24h: -1.23,
    logoUrl: "https://assets.coingecko.com/coins/images/1/small/bitcoin.png",
  },
  {
    symbol: "ETH",
    name: "Ethereum (Stellar)",
    address: "GBVOL67TMUQBGL4TZYNMY3ZQ5WGQYFPFD5VJRWEXYGN2WTLHHQ73XK2K",
    decimals: 7,
    price: 3512.8,
    priceChange24h: 0.65,
    logoUrl: "https://assets.coingecko.com/coins/images/279/small/ethereum.png",
  },
  {
    symbol: "AQUA",
    name: "Aquarius",
    address: "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA",
    decimals: 7,
    price: 0.00082,
    priceChange24h: 5.67,
    logoUrl: "https://assets.coingecko.com/coins/images/17217/small/aquarius.png",
  },
];

router.get("/tokens", (req, res) => {
  const parsed = ListTokensResponse.safeParse(TOKENS);
  if (!parsed.success) {
    req.log.error({ error: parsed.error }, "Token validation failed");
    return res.status(500).json({ error: "Internal server error" });
  }
  res.json(parsed.data);
});

export default router;
