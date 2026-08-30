# Website current-V2 data contract

The V2 public website is narrower than the backend's historical registry: it publishes only Ponsr-attributed launches from `pons-v2-current-7ed` (`0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`, start block `26841846`). Older deployment history remains in repository documentation and is deliberately absent from the public website.

The static snapshot is the last-known-good safety layer. The Netlify function may advance it in a response after bounded reads, but does not mutate repository files, backend state, contracts, or databases. Feed timestamps have separate meanings: event time is block time, observation time is when the website function looked, and generation time is the complete watermark. Observation time must never replace missing event time.

PSTONKS is the bound current-V2 canary. Its curve, splitter, deployer, native pair, transaction, block, block time, reserve observation, and CurveBuy/CurveSell counts are public provenance. Reserve values are timestamped observations, not price, market-cap, or executable-liquidity claims. Fee collection is untested; the website and terms do not imply it occurred.
