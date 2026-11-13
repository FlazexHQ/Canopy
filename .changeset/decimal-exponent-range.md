---
"@canopy/protocol": patch
"@canopy/matcher": patch
---

`Decimal128` now refuses strings whose exponent is beyond the range a Decimal128 can hold (such as `1e300000000`), and EJSON decoding reports them as an invalid value. Before, such a value in a filter or subscription made the matcher compute with a number of hundreds of millions of digits.
