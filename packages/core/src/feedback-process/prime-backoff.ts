/**
 * 质数退避（T04，ADR-0002）。
 * 等待秒数 = min(第 n 个质数, maximumBackoffSeconds)。
 * 达到上限后保持上限（非递减）；重置后重新从 2 秒开始。
 * 质数使用有界、可测试的缓存生成策略，不无限保留数组。
 */
import {
  DEFAULT_MAX_DELIVERY_BACKOFF_SECONDS,
} from "../core/types.js";

const primeCache: number[] = [];
let sieveBound = 0;

/** 生成不超过 upperBound 的全部质数（埃氏筛），结果有序。 */
function generatePrimesUpTo(upperBound: number): number[] {
  const sieve = new Uint8Array(upperBound + 1);
  sieve[0] = 1;
  sieve[1] = 1;
  for (let candidate = 2; candidate * candidate <= upperBound; candidate++) {
    if (sieve[candidate] === 0) {
      for (
        let multiple = candidate * candidate;
        multiple <= upperBound;
        multiple += candidate
      ) {
        sieve[multiple] = 1;
      }
    }
  }
  const primes: number[] = [];
  for (let value = 2; value <= upperBound; value++) {
    if (sieve[value] === 0) {
      primes.push(value);
    }
  }
  return primes;
}

function ensurePrimeCache(upperBound: number): void {
  if (sieveBound >= upperBound) {
    return;
  }
  const newlyGeneratedPrimes = generatePrimesUpTo(upperBound);
  primeCache.length = 0;
  primeCache.push(...newlyGeneratedPrimes);
  sieveBound = upperBound;
}

/**
 * 计算第 busyAttemptNumber 轮忙碌后的等待秒数（1 起）。
 * 第 1 轮 = 2 秒（p₁=2），之后 3、5、7、11…，单次封顶 maximumBackoffSeconds。
 */
export function calculatePrimeBackoffSeconds(
  busyAttemptNumber: number,
  maximumBackoffSeconds: number = DEFAULT_MAX_DELIVERY_BACKOFF_SECONDS,
): number {
  if (busyAttemptNumber < 1) {
    return 2;
  }
  ensurePrimeCache(maximumBackoffSeconds);
  const nthPrime = primeCache[busyAttemptNumber - 1];
  if (nthPrime === undefined) {
    return maximumBackoffSeconds;
  }
  return Math.min(nthPrime, maximumBackoffSeconds);
}
