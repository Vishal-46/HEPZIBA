// Global error handler
module.exports = (err, req, res, next) => {
  console.error(err.stack); // Log full error internally for debugging
  
  // Do not leak internal stack traces or DB details to the client
  res.status(500).json({ 
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong on our end'
  });
};
