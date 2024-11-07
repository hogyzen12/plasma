## Getting Started

Make sure you have Rust and Solana installed.
- Rust: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- Solana: `sh -c "$(curl -sSfL https://release.solana.com/v1.18.12/install)"`

For typescript, either install npm or yarn.

You should now be able to build the program and run the test validator with the loaded program:
```bash
cargo build-sbf
./start-test-validator
```

If this fails, you may need to add a compiler flag. See here: https://solana.stackexchange.com/questions/6987/mac-platform-tools-1-16-cargo-build-sbf-error-failed-to-run-custom-build

To regenerate the typescript SDK, you can run the following script:
```bash
cd idl
node generateIdlAndClient.js
```

This will create a JSON file with the program schema as well as a rudimentary typescript client for decoding accounts and building instructions. If the script fails, you might need to install Shank and `anchor-client-gen`.
- Shank: `cargo install shank-cli`
- anchor-client-gen:
```
# npm
$ npm install --global anchor-client-gen

# yarn
$ yarn global add anchor-client-gen
```

To run the typescript tests:
- Make sure you have the test validator running
- Run the following
```
cd plasma-sdk
yarn       # (or npm install)
yarn test  # (or npm run test)
```

- Optionally you can also run the following script to parse the logs from the local validator
```
tsx examples/plasmaLogSubscribe.ts # (You can also use ts-node)
```