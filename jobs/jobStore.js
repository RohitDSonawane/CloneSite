// In-memory job state placeholder (will be fully implemented in Phase 4)
const jobStore = {
  jobs: new Map(),
  
  get(jobId) {
    return this.jobs.get(jobId);
  },

  set(jobId, jobState) {
    this.jobs.set(jobId, jobState);
  },

  updateProgress(jobId, update) {
    const job = this.jobs.get(jobId);
    if (job) {
      Object.assign(job, update);
    }
  }
};

module.exports = jobStore;
