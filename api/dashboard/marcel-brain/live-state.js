import { createBrainWriteProxy } from "../_brain-write-proxy.js";

export default createBrainWriteProxy({
  methods: ["PATCH"],
  buildPath: () => "/dashboard-api/marcel-brain/live-state"
});
