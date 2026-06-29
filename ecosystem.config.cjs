module.exports = {
  apps: [
    {
      name: "supplier-sync-worker",
      cwd: "/opt/supplier-sync",
      script: "/bin/bash",
      args: [
        "-lc",
        "while true; do pnpm cj:worker; code=$?; if [ $code -eq 0 ]; then sleep 1800; else echo \"worker failed: exit=$code\"; sleep 60; fi; done"
      ],
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 10
    },
    {
      name: "supplier-sync-products",
      cwd: "/opt/supplier-sync",
      script: "/bin/bash",
      args: ["-lc", "PORT=4173 pnpm products:view"],
      autorestart: true,
      restart_delay: 5000
    }
  ]
};
