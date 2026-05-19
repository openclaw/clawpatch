import { describe, expect, it } from "vitest";
import { reviewJobs } from "./app.js";

describe("reviewJobs", () => {
  it("defaults to floor(cores / 2) capped at 10 when --jobs is not given", () => {
    expect(reviewJobs({}, 4)).toBe(2);
    expect(reviewJobs({}, 8)).toBe(4);
    expect(reviewJobs({}, 32)).toBe(10);
    expect(reviewJobs({}, 1)).toBe(1);
  });

  it("honors explicit --jobs value", () => {
    expect(reviewJobs({ jobs: "7" }, 32)).toBe(7);
    expect(reviewJobs({ jobs: "1" }, 32)).toBe(1);
  });

  it("caps explicit --jobs at 32", () => {
    expect(reviewJobs({ jobs: "100" }, 4)).toBe(32);
  });

  it("treats invalid explicit --jobs as 1", () => {
    expect(reviewJobs({ jobs: "abc" }, 8)).toBe(1);
    expect(reviewJobs({ jobs: "0" }, 8)).toBe(1);
  });
});
