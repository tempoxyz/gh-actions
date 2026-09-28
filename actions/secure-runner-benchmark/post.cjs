require("../secure-runner/post.cjs").main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
