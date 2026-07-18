{
  description = "T3 Code server and desktop packages";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = {
    self,
    nixpkgs,
  }: let
    systems = ["x86_64-linux"];
    forAllSystems = nixpkgs.lib.genAttrs systems;
  in {
    packages = forAllSystems (
      system: let
        pkgs = nixpkgs.legacyPackages.${system};
        inherit (pkgs) lib;
        version = "0.0.28-unstable-${self.shortRev or self.dirtyShortRev or "dev"}";
        desktopUnwrapped = pkgs.t3code.unwrapped.overrideAttrs (final: previous: {
          inherit version;
          src = self;
          postPatch =
            previous.postPatch
            + ''
              substituteInPlace \
                apps/{server,desktop,web}/package.json \
                packages/contracts/package.json \
                --replace-fail '"version": "0.0.28"' '"version": "${version}"'
            '';
          preBuild = ''
            export npm_config_nodedir=${pkgs.nodejs}
            export ELECTRON_SKIP_BINARY_DOWNLOAD=1
            pnpm rebuild --pending "''${pnpmInstallFlags[@]}" --filter '!@t3tools/monorepo'
          '';
          nativeBuildInputs =
            builtins.filter (input: lib.getName input != "pnpm") previous.nativeBuildInputs
            ++ [pkgs.pnpm_11];
          pnpmDeps = pkgs.fetchPnpmDeps {
            inherit (final) pname version src pnpmWorkspaces;
            pnpm = pkgs.pnpm_11;
            fetcherVersion = 4;
            hash = "sha256-IyExmplCYlWsChDlthkeXFGlEgSAy4XK1TBZ/IzQJ8A=";
          };
        });
        server = desktopUnwrapped.overrideAttrs (final: previous: {
          pname = "t3code-server";
          pnpmWorkspaces = [
            "@t3tools/monorepo"
            "t3..."
            "@t3tools/scripts..."
          ];
          pnpmDeps = pkgs.fetchPnpmDeps {
            inherit (final) pname version src pnpmWorkspaces;
            pnpm = pkgs.pnpm_11;
            fetcherVersion = 4;
            hash = "sha256-5T8NoEKRa748O9yunQ7MfDEoLj+0h2mAQH1TNBzZHXk=";
          };
          buildPhase = ''
            runHook preBuild
            ./node_modules/.bin/vp run --filter t3 build
            runHook postBuild
          '';
          installPhase = ''
            runHook preInstall

            pnpm --offline --config.inject-workspace-packages=true \
              --filter t3 deploy --prod $out/libexec/t3code

            rm -rf \
              $out/libexec/t3code/node_modules/.pnpm/effect@*/node_modules/effect/src \
              $out/libexec/t3code/node_modules/.pnpm/node-pty@*/node_modules/node-pty/{deps,prebuilds,scripts,src,typings}
            find $out/libexec/t3code -type f \( -name '*.d.ts' -o -name '*.map' \) -delete
            find $out/libexec/t3code/node_modules -type d -name .bin -prune -exec rm -rf {} +
            find $out/libexec/t3code/node_modules/.pnpm/node-pty@*/node_modules/node-pty/build \
              -mindepth 1 -maxdepth 1 ! -name Release -exec rm -rf {} +

            makeWrapper ${lib.getExe pkgs.nodejs} $out/bin/t3 \
              --add-flags $out/libexec/t3code/dist/bin.mjs

            runHook postInstall
          '';
          desktopItems = [];
          meta =
            previous.meta
            // {
              description = "T3 Code server for coding agents";
              mainProgram = "t3";
            };
        });
        desktop = pkgs.symlinkJoin {
          name = "t3code-desktop-${version}";
          paths = [desktopUnwrapped];
          pathsToLink = [
            "/bin"
            "/share/applications"
            "/share/icons"
          ];
          postBuild = "rm $out/bin/t3";
          passthru.unwrapped = desktopUnwrapped;
          meta =
            desktopUnwrapped.meta
            // {
              description = "T3 Code desktop client for coding agents";
              mainProgram = "t3code-desktop";
            };
        };
      in {
        inherit desktop server;
        unwrapped = desktopUnwrapped;
        default = desktop;
      }
    );

    apps = forAllSystems (system: {
      desktop = {
        type = "app";
        program = "${self.packages.${system}.desktop}/bin/t3code-desktop";
      };
      server = {
        type = "app";
        program = "${self.packages.${system}.server}/bin/t3";
      };
      default = self.apps.${system}.desktop;
    });

    formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.alejandra);
  };
}
