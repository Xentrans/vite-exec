console.log("start");

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function main() {
  await delay(200);
  console.log("done");
}

main();
