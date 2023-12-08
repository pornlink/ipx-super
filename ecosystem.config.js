module.exports = [{
  script: './dist/app.mjs',
  name: 'app',
  exec_mode: 'cluster',
  instances : "max",
}]
